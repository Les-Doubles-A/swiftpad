//! Bouchon : signatures de Tauri 2 telles que connues (vérification de typage uniquement).
use std::path::PathBuf;
pub use tauri_macros_stub::{command, generate_context, generate_handler};
#[derive(Debug)] pub struct Error;
impl std::fmt::Display for Error { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("e") } }
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
pub trait Runtime: 'static {}
pub struct Wry; impl Runtime for Wry {}
#[derive(Default)] pub struct Context;
pub struct TauriPlugin;
#[derive(Clone, Copy, Debug)] pub enum Theme { Light, Dark }
#[derive(Clone, Copy)] pub struct PhysicalSize<T> { pub width: T, pub height: T }
#[derive(Clone, Copy)] pub struct PhysicalPosition<T> { pub x: T, pub y: T }
pub struct LogicalSize<T> { pub width: T, pub height: T }
pub struct LogicalPosition<T> { pub x: T, pub y: T }
impl PhysicalSize<u32> { pub fn to_logical<X: From<f64>>(&self, _s: f64) -> LogicalSize<X> { LogicalSize { width: X::from(1.0), height: X::from(1.0) } } }
impl PhysicalPosition<i32> { pub fn to_logical<X: From<f64>>(&self, _s: f64) -> LogicalPosition<X> { LogicalPosition { x: X::from(1.0), y: X::from(1.0) } } }
pub struct CloseRequestApi; impl CloseRequestApi { pub fn prevent_close(&self) {} }
#[non_exhaustive] pub enum DragDropEvent { Enter { paths: Vec<PathBuf>, position: PhysicalPosition<f64> }, Over { position: PhysicalPosition<f64> }, Drop { paths: Vec<PathBuf>, position: PhysicalPosition<f64> }, Leave }
#[non_exhaustive] pub enum WindowEvent { CloseRequested { api: CloseRequestApi }, DragDrop(DragDropEvent), Focused(bool), ThemeChanged(Theme) }
pub enum WebviewUrl { App(PathBuf), External(String) }
pub struct Monitor; impl Monitor { pub fn scale_factor(&self) -> f64 { 1.0 } pub fn position(&self) -> &PhysicalPosition<i32> { unimplemented!() } pub fn size(&self) -> &PhysicalSize<u32> { unimplemented!() } }
pub struct State<'r, T: Send + Sync + 'static>(&'r T);
impl<'r, T: Send + Sync + 'static> std::ops::Deref for State<'r, T> { type Target = T; fn deref(&self) -> &T { self.0 } }
impl<'r, T: Send + Sync + 'static> State<'r, T> { pub fn inner(&self) -> &'r T { self.0 } }
pub struct PathResolver<R: Runtime = Wry>(std::marker::PhantomData<R>);
impl<R: Runtime> PathResolver<R> {
  pub fn app_config_dir(&self) -> Result<PathBuf> { Err(Error) } pub fn app_local_data_dir(&self) -> Result<PathBuf> { Err(Error) }
  pub fn home_dir(&self) -> Result<PathBuf> { Err(Error) } pub fn desktop_dir(&self) -> Result<PathBuf> { Err(Error) }
  pub fn document_dir(&self) -> Result<PathBuf> { Err(Error) } pub fn download_dir(&self) -> Result<PathBuf> { Err(Error) } }
pub trait Manager<R: Runtime = Wry> {
  fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> { unimplemented!() }
  fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> { None }
  fn manage<T: Send + Sync + 'static>(&self, _s: T) -> bool { true }
  fn get_webview_window(&self, _l: &str) -> Option<WebviewWindow<R>> { None }
  fn path(&self) -> &PathResolver<R> { unimplemented!() }
}
pub trait Emitter<R: Runtime = Wry> { fn emit<S: Clone>(&self, _e: &str, _p: S) -> Result<()> { Ok(()) } }
pub struct AppHandle<R: Runtime = Wry>(std::marker::PhantomData<R>);
impl<R: Runtime> Clone for AppHandle<R> { fn clone(&self) -> Self { AppHandle(std::marker::PhantomData) } }
impl<R: Runtime> AppHandle<R> { pub fn available_monitors(&self) -> Result<Vec<Monitor>> { Ok(vec![]) } }
impl<R: Runtime> Manager<R> for AppHandle<R> {} impl<R: Runtime> Emitter<R> for AppHandle<R> {}
pub struct App<R: Runtime = Wry>(AppHandle<R>);
impl<R: Runtime> App<R> { pub fn handle(&self) -> &AppHandle<R> { &self.0 } }
impl<R: Runtime> Manager<R> for App<R> {}
pub struct Window<R: Runtime = Wry>(std::marker::PhantomData<R>);
impl<R: Runtime> Clone for Window<R> { fn clone(&self) -> Self { Window(std::marker::PhantomData) } }
macro_rules! winapi { ($t:ident) => { impl<R: Runtime> $t<R> {
  pub fn is_maximized(&self) -> Result<bool> { Ok(false) } pub fn is_minimized(&self) -> Result<bool> { Ok(false) } pub fn is_visible(&self) -> Result<bool> { Ok(true) }
  pub fn inner_size(&self) -> Result<PhysicalSize<u32>> { Err(Error) } pub fn outer_position(&self) -> Result<PhysicalPosition<i32>> { Err(Error) }
  pub fn scale_factor(&self) -> Result<f64> { Ok(1.0) } pub fn set_title(&self, _t: &str) -> Result<()> { Ok(()) }
  pub fn show(&self) -> Result<()> { Ok(()) } pub fn set_focus(&self) -> Result<()> { Ok(()) } pub fn close(&self) -> Result<()> { Ok(()) }
  pub fn unminimize(&self) -> Result<()> { Ok(()) } pub fn maximize(&self) -> Result<()> { Ok(()) } pub fn app_handle(&self) -> &AppHandle<R> { unimplemented!() } }
  impl<R: Runtime> Manager<R> for $t<R> {} impl<R: Runtime> Emitter<R> for $t<R> {} } }
winapi!(Window);
pub struct WebviewWindow<R: Runtime = Wry>(std::marker::PhantomData<R>);
impl<R: Runtime> Clone for WebviewWindow<R> { fn clone(&self) -> Self { WebviewWindow(std::marker::PhantomData) } }
winapi!(WebviewWindow);
impl<R: Runtime> WebviewWindow<R> { pub fn print(&self) -> Result<()> { Ok(()) } pub fn set_theme(&self, _t: Option<Theme>) -> Result<()> { Ok(()) } pub fn theme(&self) -> Result<Theme> { Ok(Theme::Light) } }
// Poignée de fenêtre (raw-window-handle) : implémentée pour Window et WebviewWindow.
pub trait HasWindowHandle {} impl<R: Runtime> HasWindowHandle for Window<R> {} impl<R: Runtime> HasWindowHandle for WebviewWindow<R> {}
pub struct WebviewWindowBuilder<'a, R: Runtime, M: Manager<R>>(&'a M, std::marker::PhantomData<R>);
impl<'a, R: Runtime, M: Manager<R>> WebviewWindowBuilder<'a, R, M> {
  pub fn new<L: Into<String>>(m: &'a M, _l: L, _u: WebviewUrl) -> Self { WebviewWindowBuilder(m, std::marker::PhantomData) }
  pub fn title<S: Into<String>>(self, _t: S) -> Self { self } pub fn inner_size(self, _w: f64, _h: f64) -> Self { self }
  pub fn min_inner_size(self, _w: f64, _h: f64) -> Self { self } pub fn visible(self, _v: bool) -> Self { self }
  pub fn theme(self, _t: Option<Theme>) -> Self { self } pub fn initialization_script(self, _s: &str) -> Self { self }
  pub fn position(self, _x: f64, _y: f64) -> Self { self } pub fn center(self) -> Self { self }
  pub fn build(self) -> Result<WebviewWindow<R>> { Err(Error) } }
pub struct Builder<R: Runtime = Wry>(std::marker::PhantomData<R>);
impl Default for Builder<Wry> { fn default() -> Self { Builder(std::marker::PhantomData) } }
impl<R: Runtime> Builder<R> {
  pub fn plugin(self, _p: TauriPlugin) -> Self { self }
  pub fn invoke_handler<F: Fn(ipc::Invoke<R>) -> bool + Send + Sync + 'static>(self, _f: F) -> Self { self }
  pub fn on_window_event<F: Fn(&Window<R>, &WindowEvent) + Send + Sync + 'static>(self, _f: F) -> Self { self }
  pub fn setup<F: FnOnce(&mut App<R>) -> std::result::Result<(), Box<dyn std::error::Error>> + Send + 'static>(self, _f: F) -> Self { self }
  pub fn run(self, _c: Context) -> Result<()> { Ok(()) } }
pub mod ipc {
  pub struct Invoke<R: super::Runtime = super::Wry>(std::marker::PhantomData<R>);
  pub enum InvokeBody { Json(()), Raw(Vec<u8>) }
  pub struct Request<'a>(&'a InvokeBody); impl<'a> Request<'a> { pub fn body(&self) -> &InvokeBody { self.0 } }
  pub struct Response; impl Response { pub fn new<B: Into<Vec<u8>>>(_b: B) -> Self { Response } }
}
pub mod async_runtime {
  pub struct JoinError; impl std::fmt::Display for JoinError { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("j") } }
  pub struct JoinHandle<T>(std::marker::PhantomData<T>);
  impl<T> std::future::Future for JoinHandle<T> { type Output = Result<T, JoinError>; fn poll(self: std::pin::Pin<&mut Self>, _c: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> { std::task::Poll::Pending } }
  pub fn spawn_blocking<F: FnOnce() -> T + Send + 'static, T: Send + 'static>(_f: F) -> JoinHandle<T> { JoinHandle(std::marker::PhantomData) }
}
