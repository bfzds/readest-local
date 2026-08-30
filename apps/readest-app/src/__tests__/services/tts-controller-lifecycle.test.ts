import { beforeEach, describe, expect, test, vi } from 'vitest';
import { makeControllableSpeak } from '../helpers/failure-injection';
import { TTSController } from '@/services/tts/TTSController';
import { TTSClient, TTSMessageEvent } from '@/services/tts/TTSClient';
import { FoliateView } from '@/types/view';

// Focused lifecycle suite: controller-owned #tts, the state-change event
// channel, and terminal (tts-session-ended) semantics. Mocks mirror the
// controller-timeline suite's harness.

const makeMockClient = (name: string): TTSClient => ({
  name,
  initialized: true,
  init: vi.fn().mockResolvedValue(true),
  shutdown: vi.fn().mockResolvedValue(undefined),
  speak: vi.fn().mockImplementation(async function* (): AsyncIterable<TTSMessageEvent> {
    yield { code: 'end', message: 'done' };
  }),
  pause: vi.fn().mockResolvedValue(true),
  resume: vi.fn().mockResolvedValue(true),
  stop: vi.fn().mockResolvedValue(undefined),
  setPrimaryLang: vi.fn(),
  setRate: vi.fn().mockResolvedValue(undefined),
  setPitch: vi.fn().mockResolvedValue(undefined),
  setVoice: vi.fn().mockResolvedValue(undefined),
  getAllVoices: vi.fn().mockResolvedValue([]),
  getVoices: vi.fn().mockResolvedValue([]),
  getGranularities: vi.fn().mockReturnValue(['sentence']),
  getCapabilities: vi.fn().mockReturnValue({
    wordBoundaries: false,
    mediaClock: false,
    gapControl: false,
    liveRateChange: false,
  }),
  getVoiceId: vi.fn().mockReturnValue('lifecycle-voice'),
  getSpeakingLang: vi.fn().mockReturnValue('en'),
});

vi.mock('@/services/tts/WebSpeechClient', () => ({
  WebSpeechClient: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, makeMockClient('web-speech'));
  }),
}));
vi.mock('@/services/tts/NativeTTSClient', () => ({
  NativeTTSClient: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, makeMockClient('native'));
  }),
}));
vi.mock('@/services/tts/TTSUtils', () => ({
  TTSUtils: {
    getPreferredClient: vi.fn().mockReturnValue('web-speech'),
    setPreferredClient: vi.fn(),
    setPreferredVoice: vi.fn(),
    getPreferredVoice: vi.fn().mockReturnValue(null),
  },
}));
vi.mock('foliate-js/overlayer.js', () => ({ Overlayer: { highlight: 'highlightFn' } }));

// Mutable per-test behavior for the mocked foliate TTS instance.
let ttsNextReturns: (string | undefined)[] = [];
interface MockTtsInstance {
  start: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  prev: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  setMark: ReturnType<typeof vi.fn>;
  getLastRange: ReturnType<typeof vi.fn>;
  doc: Document | null;
}
const mockTtsInstances: MockTtsInstance[] = [];

vi.mock('foliate-js/tts.js', () => ({
  TTS: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    const instance = {
      start: vi.fn().mockReturnValue('<speak>hello</speak>'),
      resume: vi.fn().mockReturnValue('<speak>hello</speak>'),
      next: vi.fn().mockImplementation(() => ttsNextReturns.shift()),
      prev: vi.fn().mockReturnValue(undefined),
      from: vi.fn().mockReturnValue('<speak>from</speak>'),
      setMark: vi.fn().mockReturnValue(undefined),
      getLastRange: vi.fn().mockReturnValue(undefined),
      doc: null,
    };
    Object.assign(this, instance);
    mockTtsInstances.push(instance);
  }),
  getSentences: vi.fn().mockImplementation(function* () {}),
}));
vi.mock('foliate-js/text-walker.js', () => ({ textWalker: vi.fn() }));
vi.mock('@/utils/ssml', () => ({
  filterSSMLWithLang: vi.fn((ssml: string) => ssml),
  parseSSMLMarks: vi.fn(() => ({
    plainText: 'hello',
    marks: [{ offset: 0, name: '0', text: 'hello', language: 'en' }],
  })),
}));
vi.mock('@/utils/node', () => ({ createRejectFilter: vi.fn(() => () => 1) }));
vi.mock('@/utils/lang', () => ({
  isValidLang: vi.fn(() => true),
  isCJKLang: vi.fn(() => false),
}));

const makeView = (): FoliateView => {
  const doc = document.implementation.createHTMLDocument('t');
  return {
    book: { sections: [{ createDocument: vi.fn().mockResolvedValue(doc) }] },
    renderer: {
      getContents: () => [{ doc, index: 0, overlayer: { add: vi.fn(), remove: vi.fn() } }],
      primaryIndex: 0,
    },
    language: { isCJK: false },
    getCFI: vi.fn().mockReturnValue('epubcfi(/6/2!/4/2)'),
    resolveCFI: vi.fn().mockReturnValue({ anchor: () => new Range() }),
    tts: null,
  } as unknown as FoliateView;
};

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TTSController lifecycle', () => {
  let controller: TTSController;
  let view: FoliateView;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    ttsNextReturns = [];
    mockTtsInstances.length = 0;
    view = makeView();
    controller = new TTSController(null, view);
    await controller.init();
    await controller.initViewTTS(0);
  });

  test('survives view.tts being nulled by view.close()', async () => {
    ttsNextReturns = ['<speak>next</speak>'];
    view.tts = null; // what foliate view.close() does
    controller.state = 'playing';
    await controller.forward();
    expect(mockTtsInstances[0]!.next).toHaveBeenCalled();
  });

  test('state changes dispatch tts-state-change once per actual change, on a microtask', async () => {
    const events: string[] = [];
    controller.addEventListener('tts-state-change', (e) => {
      events.push((e as CustomEvent).detail.state);
    });
    controller.state = 'playing';
    expect(events).toHaveLength(0); // deferred, not re-entrant
    await flushMicrotasks();
    expect(events).toEqual(['playing']);
    controller.state = 'playing'; // idempotent assignment
    await flushMicrotasks();
    expect(events).toEqual(['playing']);
    controller.state = 'paused';
    await flushMicrotasks();
    expect(events).toEqual(['playing', 'paused']);
  });

  test('a paragraph-advance cycle fires no tts-session-ended', async () => {
    const ended = vi.fn();
    controller.addEventListener('tts-session-ended', ended);
    // Hold the auto-advance chain after one paragraph: a speak that ends on
    // 'boundary' does not trigger forward(), so the single advance under test
    // is isolated from the mock queue running dry.
    (controller.ttsClient.speak as ReturnType<typeof vi.fn>).mockImplementation(
      async function* (): AsyncIterable<TTSMessageEvent> {
        yield { code: 'boundary', message: 'chunk', mark: '0' };
      },
    );
    ttsNextReturns = ['<speak>next</speak>'];
    controller.state = 'playing';
    await controller.forward(); // stop() -> 'stopped' -> speak -> 'playing'
    await flushMicrotasks();
    expect(mockTtsInstances[0]!.next).toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
    expect(controller.terminated).toBe(false);
  });

  test('end of book fires tts-session-ended exactly once with reason ended', async () => {
    const ended = vi.fn();
    controller.addEventListener('tts-session-ended', ended);
    ttsNextReturns = [undefined]; // no next paragraph and no next section
    controller.state = 'playing';
    await controller.forward();
    await flushMicrotasks();
    expect(ended).toHaveBeenCalledTimes(1);
    expect((ended.mock.calls[0]![0] as CustomEvent).detail.reason).toBe('ended');
    expect(controller.terminated).toBe(true);
  });

  test('a new speak resets terminated', async () => {
    ttsNextReturns = [undefined];
    controller.state = 'playing';
    await controller.forward(); // terminates
    expect(controller.terminated).toBe(true);
    (controller.ttsClient.speak as ReturnType<typeof vi.fn>).mockImplementation(
      async function* (): AsyncIterable<TTSMessageEvent> {
        yield { code: 'boundary', message: 'chunk', mark: '0' };
      },
    );
    await controller.speak('<speak>again</speak>');
    await flushMicrotasks();
    expect(controller.terminated).toBe(false);
  });

  test('旧会话迟到 finally 不吞掉新会话（C-5）', async () => {
    const controllable = makeControllableSpeak<TTSMessageEvent>();
    (controller.ttsClient.speak as ReturnType<typeof vi.fn>).mockImplementation(
      controllable.speak as never,
    );
    ttsNextReturns = ['<speak>next</speak>'];

    // 第一次 speak 挂起（模拟慢引擎），不产出任何事件。
    const p1 = controller.speak('<speak>one</speak>');
    await flushMicrotasks();
    const handle1 = controllable.handles[0]!;

    // 第二次 speak 正常播放并结束。
    const p2 = controller.speak('<speak>two</speak>');
    await flushMicrotasks();
    const handle2 = controllable.handles[1]!;
    await handle2.emit({ code: 'boundary', message: 'chunk', mark: '0' });
    await flushMicrotasks();
    await handle2.end();
    await flushMicrotasks();
    await p2;

    // 旧会话此刻才收尾（迟到 finally）—— 绝不能 abort 已接管的新会话。
    await handle1.end();
    await flushMicrotasks();
    await p1;

    // 第三次 speak 仍能发声，设备未因旧会话迟到清理而失效。
    const p3 = controller.speak('<speak>three</speak>');
    await flushMicrotasks();
    const handle3 = controllable.handles[2]!;
    await handle3.emit({ code: 'boundary', message: 'chunk', mark: '0' });
    await flushMicrotasks();
    await handle3.end();
    await flushMicrotasks();
    await p3;
    expect(controller.terminated).toBe(false);
  });
});
