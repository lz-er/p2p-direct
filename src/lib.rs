#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used)]
#![cfg_attr(not(test), deny(clippy::panic))]

pub mod codec;
pub mod deflate;
pub mod json;
pub mod log;
pub mod mesh;
pub mod protocol;
pub mod rpc;
