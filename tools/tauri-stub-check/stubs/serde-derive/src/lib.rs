use proc_macro::TokenStream;
#[proc_macro_derive(Deserialize)]
pub fn d(_i: TokenStream) -> TokenStream { TokenStream::new() }
