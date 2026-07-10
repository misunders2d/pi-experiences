# Third-party notices

`pi-experiences` itself is MIT licensed. Its optional fully managed local duplicate-prevention path uses the following pinned third-party components.

## paraphrase-multilingual-MiniLM-L12-v2

- Base model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
- ONNX conversion/source files: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
- Pinned revision: `2c4055b12046f11709e9df2c122e59ffbdc2f900`
- License: Apache License 2.0
- Source: https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2

Model/tokenizer assets are not bundled in the npm package. They are downloaded only after explicit user enablement, then size/hash verified in the private state root.

## ONNX Runtime Web

- Package: `onnxruntime-web@1.27.0`
- License: MIT
- Source: https://www.npmjs.com/package/onnxruntime-web

The package vendors exact copies of:

- `ort.node.min.mjs`
- `ort-wasm-simd-threaded.mjs`

The matching `ort-wasm-simd-threaded.wasm` is downloaded only after explicit enablement and verified before use.

Copyright (c) Microsoft Corporation. All rights reserved.

## Hugging Face Tokenizers

- Package: `@huggingface/tokenizers@0.1.3`
- License: Apache License 2.0
- Source: https://www.npmjs.com/package/@huggingface/tokenizers

Apache-2.0 and MIT license texts remain available from the linked upstream sources and installed package metadata.
