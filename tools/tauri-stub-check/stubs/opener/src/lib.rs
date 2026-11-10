use std::path::Path;
use tauri::{Manager, Runtime};
pub fn init() -> tauri::TauriPlugin { tauri::TauriPlugin }
pub struct Opener<R: Runtime>(std::marker::PhantomData<R>);
impl<R: Runtime> Opener<R> {
  pub fn reveal_item_in_dir<P: AsRef<Path>>(&self, _p: P) -> tauri::Result<()> { Ok(()) }
  pub fn open_path(&self, _p: impl Into<String>, _w: Option<impl Into<String>>) -> tauri::Result<()> { Ok(()) }
  pub fn open_url(&self, _u: impl Into<String>, _w: Option<impl Into<String>>) -> tauri::Result<()> { Ok(()) } }
pub trait OpenerExt<R: Runtime> { fn opener(&self) -> &Opener<R>; }
impl<R: Runtime, T: Manager<R>> OpenerExt<R> for T { fn opener(&self) -> &Opener<R> { unimplemented!() } }
