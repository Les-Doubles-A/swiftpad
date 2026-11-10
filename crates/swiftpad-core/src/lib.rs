//! Noyau de SwiftPad.
//!
//! Toute la logique qui touche au système de fichiers vit ici, sans aucune
//! dépendance externe, afin d'être testée indépendamment de l'interface et
//! de Tauri. La couche Tauri (`src-tauri`) ne fait que transmettre les
//! requêtes de l'interface à [`rpc::Core::handle`].

pub mod bigfile;
pub mod bytes;
pub mod encoding;
pub mod eol;
pub mod error;
pub mod fsops;
pub mod jobs;
pub mod json;
pub mod names;
pub mod paths;
pub mod platform;
pub mod rpc;
pub mod search;
pub mod settings;
pub mod store;
pub mod textfile;
pub mod time;

#[doc(hidden)]
pub mod testutil;

pub use error::{ApiError, ApiResult};
pub use json::Json;
