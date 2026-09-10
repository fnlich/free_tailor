const assert = require('node:assert/strict');
const test = require('node:test');

const { extractJSON } = require('../dist/utils/json');
const {
  JSON_BEGIN_SENTINEL,
  JSON_END_SENTINEL,
  JSON_ONLY_SYSTEM_PROMPT,
  JSON_SENTINEL_SYSTEM_PROMPT,
} = require('../dist/services/ai/promptAssembly');

/**
 * Getting JSON back out of a chat window.
 *
 * Every case here is a shape a real reply takes. The reply reaches this app as
 * the page's rendered innerText, so it arrives with whatever the model said
 * around it and WITHOUT the markdown it said it in - a fence renders to a code
 * block and the backticks are gone. What survives rendering is ordinary text,
 * which is why the answer is delimited by sentinels rather than by fences.
 */

const wrap = (json) => `${JSON_BEGIN_SENTINEL}\n${json}\n${JSON_END_SENTINEL}`;

test('the extractor and the prompt agree on the sentinels', () => {
  // They are declared in two places on purpose - the extractor must not import
  // the AI layer - so the pair has to be pinned somewhere.
  assert.match(extractJSON(wrap('{"pinned":true}')), /"pinned":\s*true/);
  assert.ok(JSON_SENTINEL_SYSTEM_PROMPT.includes(JSON_BEGIN_SENTINEL));
  assert.ok(JSON_SENTINEL_SYSTEM_PROMPT.includes(JSON_END_SENTINEL));
});

test('the answer survives the preamble and the closing offer', () => {
  const reply =
    "Here's the tailored resume you asked for:\n\n" +
    wrap('{"summary":"Senior backend engineer","skills":["Go","TypeScript"]}') +
    '\n\nWould you like me to adjust the tone?';
  const parsed = JSON.parse(extractJSON(reply));
  assert.equal(parsed.summary, 'Senior backend engineer');
  assert.deepEqual(parsed.skills, ['Go', 'TypeScript']);
});

test('a model that restates the instruction before obeying it is not misread', () => {
  // "I will wrap it in @@BEGIN_JSON@@ ..." puts the marker on the page twice,
  // and the answer is the LATER one. Taking the first returns the instruction
  // being quoted back.
  const reply =
    `Understood - I will wrap the result in ${JSON_BEGIN_SENTINEL} and ${JSON_END_SENTINEL}.\n` +
    wrap('{"real":true}');
  assert.deepEqual(JSON.parse(extractJSON(reply)), { real: true });
});

test('an example in the preamble does not win over the answer', () => {
  // The balanced scan takes the FIRST thing shaped like JSON, which in a reply
  // that explains itself is an example. The sentinels are what stop that.
  const reply = `The shape is {"wrong":1}, so here it is:\n${wrap('{"right":1}')}`;
  assert.deepEqual(JSON.parse(extractJSON(reply)), { right: 1 });
});

test('a fenced answer still works when the sentinels are missing', () => {
  const reply = 'Sure:\n```json\n{"a":1}\n```\nHope that helps!';
  assert.deepEqual(JSON.parse(extractJSON(reply)), { a: 1 });
});

test('the repairs cover the mistakes a chat model actually makes', () => {
  const cases = [
    ['trailing commas', '{"a":1,"b":[2,3,],}', { a: 1, b: [2, 3] }],
    ['line comments', '{\n // the summary\n "a":1\n}', { a: 1 }],
    ['block comments', '{/* notes */"a":1}', { a: 1 }],
    ['curly quotes as delimiters', '{\u201Ca\u201D:\u201Cb\u201D}', { a: 'b' }],
    ['an ellipsis standing in for the rest', '{"skills":["Go","TypeScript", ...]}', { skills: ['Go', 'TypeScript'] }],
  ];
  for (const [name, damaged, expected] of cases) {
    assert.deepEqual(JSON.parse(extractJSON(wrap(damaged))), expected, name);
  }
});

test('a repair never rewrites a document that was already valid', () => {
  // The repairs run only after an honest parse has failed. An apostrophe inside
  // prose is the case that matters: rewritten, it would corrupt real content.
  const intact = '{"note":"the team\u2019s roadmap \u2014 shipped","quote":"she said \\"yes\\""}';
  const out = extractJSON(wrap(intact));
  const parsed = JSON.parse(out);
  assert.equal(parsed.note, 'the team\u2019s roadmap \u2014 shipped');
  assert.equal(parsed.quote, 'she said "yes"');
});

test('an answer cut off before its closing marker still yields what arrived', () => {
  // A deadline can end a turn between the JSON and the marker after it.
  const reply = `${JSON_BEGIN_SENTINEL}\n{"a":1}`;
  assert.deepEqual(JSON.parse(extractJSON(reply)), { a: 1 });
});

test('prose with no JSON in it fails rather than inventing something', () => {
  assert.throws(
    () => extractJSON("I'd be happy to help! Could you share the job description?"),
    /No valid JSON object found/
  );
});

test('the sentinel instruction names every failure it is there to prevent', () => {
  // The instruction is the cheap half of this: each clause corresponds to a
  // shape the extractor would otherwise have to repair.
  const text = JSON_SENTINEL_SYSTEM_PROMPT.toLowerCase();
  for (const rule of ['no preamble', 'code fence', 'double quotes', 'trailing comma', 'escape']) {
    assert.ok(text.includes(rule), `the instruction must cover: ${rule}`);
  }
  // And the short one must NOT ask for sentinels - it goes to providers that
  // enforce JSON themselves, where a sentinel would corrupt the output.
  assert.ok(!JSON_ONLY_SYSTEM_PROMPT.includes(JSON_BEGIN_SENTINEL));
});
