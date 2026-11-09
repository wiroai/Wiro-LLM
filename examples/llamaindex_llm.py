# LlamaIndex's OpenAILike LLM, pointed at the Wiro LLM gateway.
#
#   pip install llama-index-llms-openai-like
#   WIRO_API_KEY=your-api-key python llamaindex_llm.py

import os

from llama_index.llms.openai_like import OpenAILike

llm = OpenAILike(
    model="openai/gpt-5-4-nano",
    api_base="https://llm.wiro.ai/v1",
    api_key=os.environ["WIRO_API_KEY"],
    is_chat_model=True,
    is_function_calling_model=True,
    context_window=400000,
)

print(llm.complete("Explain what an API gateway does in one sentence."))
