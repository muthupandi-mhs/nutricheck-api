import { ConfigService } from '@nestjs/config';
import { GeminiTranscriptionService } from '../gemini.service';
import {
  TranscriptionEmptyError,
  TranscriptionUnavailableError,
} from '../transcription.service';

/**
 * The Gemini client, without a network.
 *
 * Most of these are about the RESPONSE SHAPE. Gemini's REST surface has moved
 * between `generateContent` and the Interactions API, and a transcription route
 * that breaks on the provider's next revision is a dictation feature that dies
 * silently — the user just gets "could not hear that" forever.
 */

const config = (over: Record<string, unknown> = {}) =>
  ({
    get: (key: string) =>
      ({ GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-3.7-flash', ...over })[key],
  }) as unknown as ConfigService<never, true>;

const audio = { audio: Buffer.from('fake-audio'), mimeType: 'audio/wav', locale: 'en-IN' as const };

function respondWith(body: unknown, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('configuration', () => {
  it('reports itself unconfigured without a key, so the route can 503', () => {
    const service = new GeminiTranscriptionService(config({ GEMINI_API_KEY: undefined }));
    expect(service.isConfigured).toBe(false);
  });

  it('is configured with a key', () => {
    expect(new GeminiTranscriptionService(config()).isConfigured).toBe(true);
  });

  it('refuses to call out without a key rather than sending a null header', async () => {
    const service = new GeminiTranscriptionService(config({ GEMINI_API_KEY: undefined }));
    await expect(service.transcribe(audio)).rejects.toBeInstanceOf(
      TranscriptionUnavailableError,
    );
  });
});

describe('response shapes', () => {
  it('reads the live Interactions shape — text lives in a model_output step', async () => {
    // Verified against the real API: there is no output_text on the REST
    // response, only steps[].
    global.fetch = respondWith({
      steps: [
        { type: 'thought', signature: 'opaque' },
        { type: 'model_output', content: [{ type: 'text', text: 'two plate chicken' }] },
      ],
    }) as never;
    const result = await new GeminiTranscriptionService(config()).transcribe(audio);
    expect(result.text).toBe('two plate chicken');
  });

  it('never lets a thought step into the transcript', async () => {
    // The failure this guards against is not a crash. It is the model's private
    // reasoning being written into a food log as if the user had said it.
    global.fetch = respondWith({
      steps: [
        { type: 'thought', content: [{ type: 'text', text: 'The user seems to be saying...' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'rendu dosai' }] },
      ],
    }) as never;
    const result = await new GeminiTranscriptionService(config()).transcribe(audio);
    expect(result.text).toBe('rendu dosai');
    expect(result.text).not.toContain('seems to be saying');
  });

  it('reads the Interactions API output_text', async () => {
    global.fetch = respondWith({ output_text: 'two plate chicken' }) as never;
    const result = await new GeminiTranscriptionService(config()).transcribe(audio);
    expect(result.text).toBe('two plate chicken');
  });

  it('reads an itemised Interactions output array', async () => {
    global.fetch = respondWith({
      output: [{ type: 'text', text: 'rendu dosai' }],
    }) as never;
    const result = await new GeminiTranscriptionService(config()).transcribe(audio);
    expect(result.text).toBe('rendu dosai');
  });

  it('still reads the older generateContent shape', async () => {
    // The shape the API served before the Interactions API. Supporting it costs
    // one branch and means a rollback on their side is not an outage on ours.
    global.fetch = respondWith({
      candidates: [{ content: { parts: [{ text: 'idli and sambar' }] } }],
    }) as never;
    const result = await new GeminiTranscriptionService(config()).transcribe(audio);
    expect(result.text).toBe('idli and sambar');
  });

  it('joins multiple parts rather than taking only the first', async () => {
    global.fetch = respondWith({
      output: [{ text: 'two rotis' }, { text: 'and dal' }],
    }) as never;
    const result = await new GeminiTranscriptionService(config()).transcribe(audio);
    expect(result.text).toBe('two rotis and dal');
  });

  it('treats an unrecognised shape as empty, not as text', async () => {
    global.fetch = respondWith({ something: 'unexpected' }) as never;
    await expect(new GeminiTranscriptionService(config()).transcribe(audio)).rejects.toBeInstanceOf(
      TranscriptionEmptyError,
    );
  });

  it('treats silence as empty rather than inventing words', async () => {
    global.fetch = respondWith({ output_text: '   ' }) as never;
    await expect(new GeminiTranscriptionService(config()).transcribe(audio)).rejects.toBeInstanceOf(
      TranscriptionEmptyError,
    );
  });
});

describe('failures', () => {
  it('maps a provider error status to unavailable', async () => {
    global.fetch = respondWith({ error: { message: 'quota exceeded' } }, false, 429) as never;
    await expect(new GeminiTranscriptionService(config()).transcribe(audio)).rejects.toBeInstanceOf(
      TranscriptionUnavailableError,
    );
  });

  it('maps a dead socket to unavailable, so the app degrades to on-device', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
    await expect(new GeminiTranscriptionService(config()).transcribe(audio)).rejects.toBeInstanceOf(
      TranscriptionUnavailableError,
    );
  });

  it('survives a body that is not JSON at all', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    }) as never;
    await expect(new GeminiTranscriptionService(config()).transcribe(audio)).rejects.toBeInstanceOf(
      TranscriptionEmptyError,
    );
  });
});

describe('the request', () => {
  it('sends the key as a header and the audio as base64', async () => {
    const fetchMock = respondWith({ output_text: 'ok' });
    global.fetch = fetchMock as never;

    await new GeminiTranscriptionService(config()).transcribe(audio);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('generativelanguage.googleapis.com');
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'test-key' });

    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.model).toBe('gemini-3.7-flash');
    const audioPart = sent.input.find((p: { type: string }) => p.type === 'audio');
    expect(audioPart.mime_type).toBe('audio/wav');
    expect(Buffer.from(audioPart.data, 'base64').toString()).toBe('fake-audio');
  });

  it('tells the model which language to expect', async () => {
    // Guessing the language is exactly what mangles code-switched speech.
    const fetchMock = respondWith({ output_text: 'ok' });
    global.fetch = fetchMock as never;

    await new GeminiTranscriptionService(config()).transcribe({ ...audio, locale: 'ta-IN' });

    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    const prompt = sent.input.find((p: { type: string }) => p.type === 'text').text;
    expect(prompt).toContain('Tamil');
    expect(prompt).toContain('rendu dosai');
  });

  it('instructs a verbatim transcript, not an answer to the audio', async () => {
    // Left to itself a multimodal model will summarise, translate or reply —
    // and any of those silently destroys a log.
    const fetchMock = respondWith({ output_text: 'ok' });
    global.fetch = fetchMock as never;

    await new GeminiTranscriptionService(config()).transcribe(audio);

    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    const prompt = sent.input.find((p: { type: string }) => p.type === 'text').text;
    expect(prompt).toContain('verbatim');
    expect(prompt).toContain('Do not translate');
  });
});
