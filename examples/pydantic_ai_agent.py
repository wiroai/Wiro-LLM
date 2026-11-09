# Pydantic AI with its OpenAI provider, pointed at the Wiro LLM gateway.
#
#   pip install "pydantic-ai-slim[openai]"
#   WIRO_API_KEY=your-api-key python pydantic_ai_agent.py

import os

from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

model = OpenAIChatModel(
    "openai/gpt-5-4-nano",
    provider=OpenAIProvider(
        base_url="https://llm.wiro.ai/v1",
        api_key=os.environ["WIRO_API_KEY"],
    ),
)

agent = Agent(model, instructions="Answer in one sentence.")
result = agent.run_sync("What does an API gateway do?")

print(result.output)
print(result.usage)
