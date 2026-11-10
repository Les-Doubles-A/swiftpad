//! Tâches longues en arrière-plan (recherche, copies, indexation) :
//! résultats livrés par lots, progression, annulation coopérative.
//!
//! L'interface interroge `poll` avec une attente bornée (attente longue) :
//! pas de sondage agressif, et les résultats arrivent dès qu'ils existent.

use crate::error::{ApiError, ApiResult};
use crate::json::{Json, Obj};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub type JobId = u64;

#[derive(Default)]
struct JobState {
    items: Vec<Json>,
    progress: Json,
    done: bool,
    result: Option<Json>,
    error: Option<ApiError>,
}

pub struct Job {
    pub kind: &'static str,
    cancel: Arc<AtomicBool>,
    state: Mutex<JobState>,
    cv: Condvar,
    last_poll: Mutex<Instant>,
}

/// Contexte passé à la fonction de travail.
#[derive(Clone)]
pub struct JobCtx {
    job: Arc<Job>,
}

impl JobCtx {
    pub fn cancelled(&self) -> bool {
        self.job.cancel.load(Ordering::Relaxed)
    }

    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.job.cancel
    }

    pub fn push(&self, item: Json) {
        let mut st = self.job.state.lock().unwrap_or_else(|e| e.into_inner());
        st.items.push(item);
        drop(st);
        self.job.cv.notify_all();
    }

    pub fn push_many(&self, items: Vec<Json>) {
        if items.is_empty() {
            return;
        }
        let mut st = self.job.state.lock().unwrap_or_else(|e| e.into_inner());
        st.items.extend(items);
        drop(st);
        self.job.cv.notify_all();
    }

    pub fn progress(&self, p: Json) {
        let mut st = self.job.state.lock().unwrap_or_else(|e| e.into_inner());
        st.progress = p;
    }

    /// Nombre d'éléments en attente de lecture (pour limiter la mémoire si
    /// l'interface ne lit plus).
    pub fn backlog(&self) -> usize {
        self.job.state.lock().map(|s| s.items.len()).unwrap_or(0)
    }
}

#[derive(Default)]
pub struct Jobs {
    map: Mutex<HashMap<JobId, Arc<Job>>>,
    next: AtomicU64,
}

/// Tâche abandonnée (plus interrogée) : annulée puis oubliée.
const ABANDON_AFTER: Duration = Duration::from_secs(120);

impl Jobs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start<F>(&self, kind: &'static str, work: F) -> JobId
    where
        F: FnOnce(&JobCtx) -> ApiResult<Json> + Send + 'static,
    {
        self.collect_garbage();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let job = Arc::new(Job {
            kind,
            cancel: Arc::new(AtomicBool::new(false)),
            state: Mutex::new(JobState { progress: Json::Null, ..Default::default() }),
            cv: Condvar::new(),
            last_poll: Mutex::new(Instant::now()),
        });
        self.map.lock().unwrap_or_else(|e| e.into_inner()).insert(id, job.clone());
        let ctx = JobCtx { job: job.clone() };
        let spawn = std::thread::Builder::new().name(format!("swiftpad-{kind}-{id}")).spawn(move || {
            let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&ctx)));
            let mut st = ctx.job.state.lock().unwrap_or_else(|e| e.into_inner());
            match res {
                Ok(Ok(v)) => st.result = Some(v),
                Ok(Err(e)) => st.error = Some(e),
                Err(_) => st.error = Some(ApiError::new("internal", "Erreur interne pendant la tâche.")),
            }
            st.done = true;
            drop(st);
            ctx.job.cv.notify_all();
        });
        if spawn.is_err() {
            let mut st = job.state.lock().unwrap_or_else(|e| e.into_inner());
            st.error = Some(ApiError::new("internal", "Impossible de démarrer la tâche."));
            st.done = true;
        }
        id
    }

    fn get(&self, id: JobId) -> ApiResult<Arc<Job>> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
            .ok_or_else(|| ApiError::new("unknown_job", "Tâche inconnue ou terminée."))
    }

    /// Renvoie les éléments disponibles (au plus `max_items`), en attendant
    /// jusqu'à `wait_ms` s'il n'y en a aucun. Une tâche terminée et vidée
    /// est oubliée après ce dernier appel.
    pub fn poll(&self, id: JobId, wait_ms: u64, max_items: usize) -> ApiResult<Json> {
        let job = self.get(id)?;
        *job.last_poll.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let deadline = Instant::now() + Duration::from_millis(wait_ms.min(5_000));
        let mut st = job.state.lock().unwrap_or_else(|e| e.into_inner());
        while st.items.is_empty() && !st.done {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let (s, _) = job.cv.wait_timeout(st, deadline - now).unwrap_or_else(|e| e.into_inner());
            st = s;
        }
        let take = st.items.len().min(max_items.max(1));
        let items: Vec<Json> = st.items.drain(..take).collect();
        let finished = st.done && st.items.is_empty();
        let out = Obj::new()
            .put("id", id)
            .put("kind", job.kind)
            .put("items", Json::Arr(items))
            .put("progress", st.progress.clone())
            .put("done", finished)
            .put("result", st.result.clone())
            .put("error", st.error.as_ref().map(|e| e.to_json()))
            .build();
        drop(st);
        if finished {
            self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        }
        Ok(out)
    }

    pub fn cancel(&self, id: JobId) -> bool {
        match self.get(id) {
            Ok(job) => {
                job.cancel.store(true, Ordering::Relaxed);
                job.cv.notify_all();
                true
            }
            Err(_) => false,
        }
    }

    pub fn cancel_all(&self) {
        for job in self.map.lock().unwrap_or_else(|e| e.into_inner()).values() {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn running(&self) -> usize {
        self.map.lock().map(|m| m.len()).unwrap_or(0)
    }

    fn collect_garbage(&self) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, job| {
            let idle = job.last_poll.lock().map(|t| t.elapsed()).unwrap_or_default();
            if idle > ABANDON_AFTER {
                job.cancel.store(true, Ordering::Relaxed);
                false
            } else {
                true
            }
        });
    }
}

/// Jetons d'annulation pour les opérations synchrones (ouverture d'un gros
/// fichier) : l'interface fournit un identifiant puis peut l'annuler.
#[derive(Default)]
pub struct CancelTokens {
    map: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl CancelTokens {
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.map.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), flag.clone());
        flag
    }

    pub fn release(&self, id: &str) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    pub fn cancel(&self, id: &str) -> bool {
        match self.map.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            Some(f) => {
                f.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_and_completion() {
        let jobs = Jobs::new();
        let id = jobs.start("test", |ctx| {
            for i in 0..10u32 {
                ctx.push(Json::from(i));
            }
            Ok(Json::from("fini"))
        });
        let mut got = Vec::new();
        loop {
            let r = jobs.poll(id, 1000, 3).unwrap();
            got.extend(r.get("items").unwrap().as_array().unwrap().iter().map(|v| v.as_u64().unwrap()));
            if r.bool_of("done").unwrap() {
                assert_eq!(r.str_of("result"), Some("fini"));
                break;
            }
        }
        assert_eq!(got, (0..10).collect::<Vec<u64>>());
        assert_eq!(jobs.poll(id, 0, 10).unwrap_err().code, "unknown_job");
    }

    #[test]
    fn cancellation_is_cooperative() {
        let jobs = Jobs::new();
        let id = jobs.start("test", |ctx| {
            let t0 = Instant::now();
            while !ctx.cancelled() {
                if t0.elapsed() > Duration::from_secs(5) {
                    return Ok(Json::from("pas annulé"));
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(ApiError::cancelled())
        });
        assert!(jobs.cancel(id));
        let mut r;
        loop {
            r = jobs.poll(id, 2000, 10).unwrap();
            if r.bool_of("done").unwrap() {
                break;
            }
        }
        assert_eq!(r.get("error").unwrap().str_of("code"), Some("cancelled"));
    }

    #[test]
    fn poll_waits_without_spinning() {
        let jobs = Jobs::new();
        let id = jobs.start("test", |ctx| {
            std::thread::sleep(Duration::from_millis(80));
            ctx.push(Json::from(1u32));
            Ok(Json::Null)
        });
        let t0 = Instant::now();
        let r = jobs.poll(id, 2000, 10).unwrap();
        assert!(t0.elapsed() >= Duration::from_millis(60));
        assert!(t0.elapsed() < Duration::from_millis(1500));
        assert_eq!(r.get("items").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn panics_become_errors() {
        let jobs = Jobs::new();
        let id = jobs.start("test", |_| panic!("boum"));
        let mut r;
        loop {
            r = jobs.poll(id, 1000, 10).unwrap();
            if r.bool_of("done").unwrap() {
                break;
            }
        }
        assert_eq!(r.get("error").unwrap().str_of("code"), Some("internal"));
    }

    #[test]
    fn cancel_tokens() {
        let t = CancelTokens::default();
        let f = t.register("a");
        assert!(t.cancel("a"));
        assert!(f.load(Ordering::Relaxed));
        t.release("a");
        assert!(!t.cancel("a"));
    }
}
