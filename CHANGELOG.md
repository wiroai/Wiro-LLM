# Changelog

## 0.2.1

README only: the More from Wiro AI table lists the current Wiro AI repositories. The provider is the same as in 0.2.0.

## 0.2.0

The provider now covers Wiro's image, speech, transcription and video models as well as chat.

- `wiro.image(modelId)` for `generateImage`: text to image, and image editing from `prompt.images` and `prompt.mask`. `n`, `size`, `aspectRatio` and `seed` go to each model's own settings, whatever they are called, and a model with an image count setting makes several images in one task.
- `wiro.speech(modelId)` for `generateSpeech`, with `voice`, `language`, `outputFormat`, `instructions` and `speed` matched to the model's own options.
- `wiro.transcription(modelId)` for `transcribe`. A public audio URL goes straight to Wiro, and segment and word timings come back when the model writes them.
- `wiro.video(modelId)` for `experimental_generateVideo`, `experimental_startVideo` and `experimental_getVideoStatus`, with start and end frames, references, `resolution`, `duration`, `fps`, `generateAudio` and webhooks.
- Model settings in `providerOptions.wiro` go to the model as they are. Required settings left out get the model's catalog default.
- Every result names its Wiro task and cost in `providerMetadata.wiro`.
- `WiroTaskError` says why a task gave no result and which task it was.
- Signature projects keep using `API_KEY:API_SECRET`: Run API requests are signed with the secret, which is never sent.
- New settings: `runBaseURL` for the Run API and `poll` for how long image, speech and transcription calls wait.
- `WiroImageModelId`, `WiroSpeechModelId`, `WiroTranscriptionModelId` and `WiroVideoModelId` list the catalog's models for autocomplete.

## 0.1.3

- First release of `@wiro-ai/wiro-llm` from GitHub Actions through npm trusted publishing, with provenance. No code changes.

## 0.1.2

- The package is now published as `@wiro-ai/wiro-llm`, the same name as this repository. It replaces `@wiro-ai/ai-sdk-provider`: install the new name and update your imports. No code changes.

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
