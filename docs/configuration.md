# Configuration

[← README](../README.md)

Everything is an environment variable, read from the shell or from `.env`. See [.env.example](../.env.example).

## Jev

```bash
TYPESAFE_API_KEY=...
TYPESAFE_MODEL=jev-latest    # default
```

## The LLM

Three variables. Anything that speaks OpenAI `chat/completions` works.

```bash
LLM_BASE_URL=https://api.anthropic.com/v1   # default
LLM_MODEL=claude-sonnet-5                   # default
LLM_API_KEY=...                             # ANTHROPIC_API_KEY is also accepted for the default endpoint
```

| Provider | `LLM_BASE_URL` | `LLM_MODEL`, for example |
| --- | --- | --- |
| Anthropic (default) | `https://api.anthropic.com/v1` | `claude-sonnet-5` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-5` |
| Ollama | `http://localhost:11434/v1` | `qwen3` (with `LLM_API_KEY=ollama`) |

Optional:

- `LLM_TEXT_MODEL` uses a smaller, faster LLM just for writing field values.
- `LLM_EXTRA_BODY` merges JSON into every request, for provider quirks. A `null` removes a default field:
  `'{"max_tokens":null,"max_completion_tokens":2048}'`.

## JSON mode is off by default

`response_format` is not portable: Anthropic's endpoint rejects `json_object` with a 400, even though its docs
call the field ignored. So the prompt asks for JSON, replies are parsed tolerantly, then validated field by
field. Opt in per provider through `LLM_EXTRA_BODY`.

Anthropic describes its OpenAI-compatible endpoint as intended for testing and comparison, not production.

## Without an LLM key

`audit` still works: the prompt is judged as one claim instead of being split
([audit.md](audit.md#how-a-claim-is-judged)). Planning, reviewing a page and writing typed text all use the LLM.
