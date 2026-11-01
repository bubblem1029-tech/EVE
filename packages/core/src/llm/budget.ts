/** Conservative fallback estimate, not an exact model tokenizer. */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii++;
    else other += char.codePointAt(0)! > 0xffff ? 3 : 2;
  }
  return Math.ceil(ascii / 3) + other;
}

export function estimateRequestTokens(body: Record<string, any>, imageTokens = 4096): number {
  let images = 0;
  const text = JSON.stringify({ messages: body.messages, tools: body.tools }, (key, value) => {
    if (key === 'image_url') { images++; return '[image]'; }
    return value;
  });
  return estimateTextTokens(text) + images * imageTokens + 128;
}

/** Only explicit server codes/messages establish a context error. */
export function isContextLengthError(data: any): boolean {
  const errors = [data?.error, data?.choices?.[0]?.error, data?.choices?.[0]?.message?.error];
  return errors.some(error => /INPUT_LENGTH_ERROR|context_length_exceeded|ContextLengthExceeded|maximum context length|input.*exceeds.*(?:length|limit)/i
    .test(typeof error === 'string' ? error : JSON.stringify(error || {})));
}
