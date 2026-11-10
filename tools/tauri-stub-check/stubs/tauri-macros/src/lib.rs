use proc_macro::TokenStream;
#[proc_macro_attribute]
pub fn command(_a: TokenStream, item: TokenStream) -> TokenStream { item }
#[proc_macro]
pub fn generate_handler(input: TokenStream) -> TokenStream {
    format!("|_invoke: ::tauri::ipc::Invoke| {{ let _ = ({},); true }}", input).parse().unwrap()
}
#[proc_macro]
pub fn generate_context(_i: TokenStream) -> TokenStream { "::tauri::Context::default()".parse().unwrap() }
