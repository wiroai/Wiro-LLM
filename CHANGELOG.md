# Changelog

## 0.1.1

- Published from GitHub Actions through npm trusted publishing, with provenance. No code changes.

## 0.1.0

First release.

- `createWiro()` and the default `wiro` provider for AI SDK 7, built on `@ai-sdk/openai-compatible` and the Wiro LLM gateway at `https://llm.wiro.ai/v1`.
- Chat models through `wiro(modelId)`, `wiro.chatModel(modelId)` and `wiro.languageModel(modelId)`, with streaming, tool calls and structured output.
- Token usage on streamed calls, and JSON schema structured output for `Output.object`.
- `providerMetadata.wiro.cost`: the amount each call was billed, in USD, for both `generateText` and `streamText`.
- The key comes from the `apiKey` option or the `WIRO_API_KEY` environment variable, read when a request is made.
- `WiroChatModelId`, with the IDs of the 67 models the gateway serves today.
