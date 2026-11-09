# The OpenAI SDK for Python, pointed at the Wiro LLM gateway.
#
#   pip install openai
#   WIRO_API_KEY=your-api-key python openai_sdk.py

import os

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["WIRO_API_KEY"],
    base_url="https://llm.wiro.ai/v1",
)

completion = client.chat.completions.create(
    model="openai/gpt-5-4-nano",
    max_completion_tokens=512,
    messages=[{"role": "user", "content": "Explain what an API gateway does in one sentence."}],
)

print(completion.choices[0].message.content)
print(f"cost: {getattr(completion.usage, 'cost', None)} USD")
