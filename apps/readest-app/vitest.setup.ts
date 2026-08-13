// jsdom does not implement the CSS namespace; foliate-js TTS uses CSS.escape
// (mark[name="…"] lookups). Provide the standard polyfill so those paths work.
const globalWithCSS = globalThis as { CSS?: { escape?: (value: string) => string } };
if (!globalWithCSS.CSS) globalWithCSS.CSS = {};
if (typeof globalWithCSS.CSS.escape !== 'function') {
  globalWithCSS.CSS.escape = (value: string): string => {
    const string = String(value);
    const length = string.length;
    const firstCodeUnit = string.charCodeAt(0);
    let result = '';
    let index = -1;
    while (++index < length) {
      const codeUnit = string.charCodeAt(index);
      if (codeUnit === 0x0000) {
        result += '�';
      } else if (
        (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
        codeUnit === 0x007f ||
        (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
      ) {
        result += '\\' + codeUnit.toString(16) + ' ';
      } else if (index === 0 && length === 1 && codeUnit === 0x002d) {
        result += '\\' + string.charAt(index);
      } else if (
        codeUnit >= 0x0080 ||
        codeUnit === 0x002d ||
        codeUnit === 0x005f ||
        (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
        (codeUnit >= 0x0061 && codeUnit <= 0x007a)
      ) {
        result += string.charAt(index);
      } else {
        result += '\\' + string.charAt(index);
      }
    }
    return result;
  };
}

// jsdom does not implement DOMMatrix, and pdf.js constructs an identity matrix
// at module scope (so loading pdf.min.mjs throws ReferenceError). Provide a
// minimal 2D implementation covering the surface pdf.js uses: transform
// arrays/strings, chained translate/scale/multiply/invert, transformPoint and
// the a..f / m11..m44 properties. Only 2D is modelled (pdf.js canvas math).
const domMatrixValue = (): {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
} => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

type DOMMatrixInit =
  | number
  | string
  | number[]
  | { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number };

class DOMMatrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;

  constructor();
  constructor(a: number, b: number, c: number, d: number, e: number, f: number);
  constructor(init?: DOMMatrixInit);
  constructor(aOrInit?: DOMMatrixInit, b = 0, c = 0, d = 1, e = 0, f = 0) {
    let v = domMatrixValue();
    if (typeof aOrInit === 'number') {
      v = { a: aOrInit, b, c, d, e, f };
    } else if (typeof aOrInit === 'string') {
      v = DOMMatrix2D.parseString(aOrInit);
    } else if (Array.isArray(aOrInit)) {
      v = DOMMatrix2D.parseArray(aOrInit);
    } else if (aOrInit && typeof aOrInit === 'object') {
      v = {
        a: aOrInit.a ?? 1,
        b: aOrInit.b ?? 0,
        c: aOrInit.c ?? 0,
        d: aOrInit.d ?? 1,
        e: aOrInit.e ?? 0,
        f: aOrInit.f ?? 0,
      };
    }
    this.a = v.a;
    this.b = v.b;
    this.c = v.c;
    this.d = v.d;
    this.e = v.e;
    this.f = v.f;
  }

  private static parseString(s: string): {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  } {
    const m =
      /^matrix\(\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*\)$/.exec(
        s,
      );
    if (m) return { a: +m[1], b: +m[2], c: +m[3], d: +m[4], e: +m[5], f: +m[6] };
    // "none" (or an unparseable string) resolves to the identity matrix.
    return domMatrixValue();
  }

  private static parseArray(arr: number[]): {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  } {
    if (arr.length === 6) {
      return { a: arr[0], b: arr[1], c: arr[2], d: arr[3], e: arr[4], f: arr[5] };
    }
    if (arr.length === 16) {
      // Column-major 4x4: [m11,m12,m13,m14, m21,m22,m23,m24, m31,m32,m33,m34, m41,m42,m43,m44]
      return { a: arr[0], b: arr[1], c: arr[4], d: arr[5], e: arr[12], f: arr[13] };
    }
    return domMatrixValue();
  }

  // W3C matrix layout is column-major; point transform is a*x + c*y + e etc.
  get is2D(): boolean {
    return true;
  }

  get isIdentity(): boolean {
    return (
      this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0
    );
  }

  get m11(): number {
    return this.a;
  }
  get m12(): number {
    return this.b;
  }
  get m21(): number {
    return this.c;
  }
  get m22(): number {
    return this.d;
  }
  get m41(): number {
    return this.e;
  }
  get m42(): number {
    return this.f;
  }
  set m11(v: number) {
    this.a = v;
  }
  set m12(v: number) {
    this.b = v;
  }
  set m21(v: number) {
    this.c = v;
  }
  set m22(v: number) {
    this.d = v;
  }
  set m41(v: number) {
    this.e = v;
  }
  set m42(v: number) {
    this.f = v;
  }
  // 3D components are constant in this 2D-only shim.
  get m13(): number {
    return 0;
  }
  get m14(): number {
    return 0;
  }
  get m23(): number {
    return 0;
  }
  get m24(): number {
    return 0;
  }
  get m31(): number {
    return 0;
  }
  get m32(): number {
    return 0;
  }
  get m33(): number {
    return 1;
  }
  get m34(): number {
    return 0;
  }
  get m43(): number {
    return 0;
  }
  get m44(): number {
    return 1;
  }

  setMatrixValue(init: string | number[]): this {
    const v =
      typeof init === 'string' ? DOMMatrix2D.parseString(init) : DOMMatrix2D.parseArray(init);
    this.a = v.a;
    this.b = v.b;
    this.c = v.c;
    this.d = v.d;
    this.e = v.e;
    this.f = v.f;
    return this;
  }

  multiply(other: {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  }): DOMMatrix2D {
    return new DOMMatrix2D(this).multiplySelf(other);
  }

  multiplySelf(other: { a: number; b: number; c: number; d: number; e: number; f: number }): this {
    const { a, b, c, d, e, f } = this;
    const { a: oa, b: ob, c: oc, d: od, e: oe, f: of } = other;
    this.a = a * oa + c * ob;
    this.b = b * oa + d * ob;
    this.c = a * oc + c * od;
    this.d = b * oc + d * od;
    this.e = a * oe + c * of + e;
    this.f = b * oe + d * of + f;
    return this;
  }

  preMultiplySelf(other: {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
  }): this {
    const { a, b, c, d, e, f } = this;
    const { a: oa, b: ob, c: oc, d: od, e: oe, f: of } = other;
    this.a = oa * a + oc * b;
    this.b = ob * a + od * b;
    this.c = oa * c + oc * d;
    this.d = ob * c + od * d;
    this.e = oa * e + oc * f + oe;
    this.f = ob * e + od * f + of;
    return this;
  }

  translate(x = 0, y = 0): DOMMatrix2D {
    return new DOMMatrix2D(this).translateSelf(x, y);
  }

  translateSelf(x = 0, y = 0): this {
    this.e += this.a * x + this.c * y;
    this.f += this.b * x + this.d * y;
    return this;
  }

  scale(x = 1, y = x): DOMMatrix2D {
    return new DOMMatrix2D(this).scaleSelf(x, y);
  }

  scaleSelf(x = 1, y = x): this {
    this.a *= x;
    this.b *= x;
    this.c *= y;
    this.d *= y;
    return this;
  }

  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (det === 0) {
      // Not invertible: the spec sets every component to NaN.
      this.a = NaN;
      this.b = NaN;
      this.c = NaN;
      this.d = NaN;
      this.e = NaN;
      this.f = NaN;
      return this;
    }
    const { a, b, c, d, e, f } = this;
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  inverse(): DOMMatrix2D {
    return new DOMMatrix2D(this).invertSelf();
  }

  transformPoint(p: { x?: number; y?: number; z?: number; w?: number }): {
    x: number;
    y: number;
    z: number;
    w: number;
  } {
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    const z = p.z ?? 0;
    const w = p.w ?? 1;
    return {
      x: this.a * x + this.c * y + this.e,
      y: this.b * x + this.d * y + this.f,
      z,
      w,
    };
  }

  static fromMatrix(m: {
    a?: number;
    b?: number;
    c?: number;
    d?: number;
    e?: number;
    f?: number;
  }): DOMMatrix2D {
    return new DOMMatrix2D(m);
  }
}

const globalWithMatrix = globalThis as { DOMMatrix?: typeof DOMMatrix };
if (!globalWithMatrix.DOMMatrix) {
  globalWithMatrix.DOMMatrix = DOMMatrix2D as unknown as typeof DOMMatrix;
}

// Simulate the Tauri IPC bridge so runtime guards (e.g. NativeAppService.init)
// treat the jsdom env as the desktop shell; the actual plugin calls are mocked
// per-test. Tests that need the "no Tauri" path stub window without it.
if (typeof window !== 'undefined') {
  const win = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (!win.__TAURI_INTERNALS__) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
      writable: true,
    });
  }
}

// matchMedia mock
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom reports these unimplemented methods to its virtual console even when
// the calling test passes. Tests that need media behavior replace them locally.
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
}
