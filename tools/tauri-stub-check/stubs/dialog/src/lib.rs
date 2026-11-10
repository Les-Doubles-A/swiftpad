use std::path::{Path, PathBuf};
use tauri::{Manager, Runtime, HasWindowHandle};
pub fn init() -> tauri::TauriPlugin { tauri::TauriPlugin }
pub struct FilePath; impl FilePath { pub fn into_path(self) -> tauri::Result<PathBuf> { Err(tauri::Error) } }
pub struct Dialog<R: Runtime>(std::marker::PhantomData<R>);
impl<R: Runtime> Dialog<R> { pub fn file(&self) -> FileDialogBuilder<R> { FileDialogBuilder(std::marker::PhantomData) } }
pub struct FileDialogBuilder<R: Runtime>(std::marker::PhantomData<R>);
impl<R: Runtime> FileDialogBuilder<R> {
  pub fn add_filter(self, _n: impl Into<String>, _e: &[&str]) -> Self { self }
  pub fn set_parent<W: HasWindowHandle>(self, _p: &W) -> Self { self }
  pub fn set_title(self, _t: impl Into<String>) -> Self { self }
  pub fn set_directory<P: AsRef<Path>>(self, _d: P) -> Self { self }
  pub fn set_file_name(self, _n: impl Into<String>) -> Self { self }
  pub fn blocking_pick_files(self) -> Option<Vec<FilePath>> { None }
  pub fn blocking_save_file(self) -> Option<FilePath> { None }
  pub fn blocking_pick_folder(self) -> Option<FilePath> { None } }
pub trait DialogExt<R: Runtime> { fn dialog(&self) -> &Dialog<R>; }
impl<R: Runtime, T: Manager<R>> DialogExt<R> for T { fn dialog(&self) -> &Dialog<R> { unimplemented!() } }
