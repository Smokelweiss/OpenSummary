/** Tiny zero-dependency test harness. */

const tests = [];
let current = null;

export function describe(name, fn) {
  const prev = current;
  current = { name, tests: [] };
  fn();
  tests.push(current);
  current = prev;
}

export function it(name, fn) {
  if (!current) throw new Error(`it("${name}") called outside describe()`);
  current.tests.push({ name, fn });
}

export function assert(cond, message = 'assertion failed') {
  if (!cond) throw new Error(message);
}

export function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

export function assertDeepEqual(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
}

export function assertThrows(fn, message = 'expected function to throw') {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message);
}

export function near(actual, expected, epsilon = 1e-6, message = '') {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message}\n  expected ~${expected}, got ${actual}`);
  }
}

export async function runAll() {
  let passed = 0;
  const failures = [];
  for (const suite of tests) {
    for (const t of suite.tests) {
      const label = `${suite.name} › ${t.name}`;
      const started = Date.now();
      try {
        await t.fn();
        passed++;
        console.log(`  ok   ${label} (${Date.now() - started}ms)`);
      } catch (err) {
        failures.push({ label, err });
        console.log(`  FAIL ${label}`);
        console.log(`       ${String(err && err.message).split('\n').join('\n       ')}`);
      }
    }
  }
  console.log('');
  console.log(`${passed} passed, ${failures.length} failed, ${passed + failures.length} total`);
  return failures.length;
}
