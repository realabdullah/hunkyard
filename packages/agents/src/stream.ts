import { type ModelTarget, OllamaChatChunkSchema, OpenAIChatChunkSchema } from '@hunkyard/domain';

/** A piece of answer text, or the end of the stream with how it ended. */
export type ChatDelta = { text: string } | { done: true; truncated: boolean };

async function* lines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      yield buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) yield buffer;
}

const json = (line: string) => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error('Model stream sent invalid JSON.');
  }
};

/**
 * Parses an Ollama NDJSON or OpenAI-compatible SSE chat stream into text deltas. A stream that
 * stops without its end marker is an error, never a silently shortened answer.
 */
export async function* chatDeltas(
  provider: ModelTarget['provider'],
  chunks: AsyncIterable<string>,
): AsyncGenerator<ChatDelta> {
  let truncated = false;
  for await (const line of lines(chunks)) {
    if (provider === 'ollama') {
      if (!line.trim()) continue;
      const chunk = OllamaChatChunkSchema.parse(json(line));
      if ('error' in chunk) throw new Error(`Model stream failed: ${chunk.error}`);
      if (chunk.message?.content) yield { text: chunk.message.content };
      if (chunk.done) {
        yield { done: true, truncated: chunk.done_reason === 'length' };
        return;
      }
      continue;
    }
    // SSE: only `data:` fields carry payloads; comments, ids and blank separators are ignored.
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      yield { done: true, truncated };
      return;
    }
    const chunk = OpenAIChatChunkSchema.parse(json(data));
    if ('error' in chunk) throw new Error(`Model stream failed: ${chunk.error.message}`);
    const choice = chunk.choices[0];
    if (choice?.delta?.content) yield { text: choice.delta.content };
    if (choice?.finish_reason === 'length') truncated = true;
  }
  throw new Error('Model stream ended early.');
}
