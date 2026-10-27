// Unit tests for definition and answer validation.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDefinition, answerError, validateAnswers } = require("../lib/validate");
const { slugify } = require("../lib/app");

const q = (over) => ({ id: "q1", type: "text", label: "Name?", ...over });

test("normalizeDefinition accepts a good form and fills defaults", () => {
  const result = normalizeDefinition(
    {
      title: "Weekly Check-in",
      questions: [
        q({}),
        q({ id: "q2", type: "choice", label: "Pick", options: ["A", "B"] }),
        q({ id: "q3", type: "rating", label: "Rate" }),
      ],
    },
    slugify,
    () => false,
  );
  assert.equal(result.error, undefined);
  assert.equal(result.form.slug, "weekly-check-in");
  assert.equal(result.form.published, true);
  assert.equal(result.form.questions[2].max, 5);
});

test("normalizeDefinition rejects bad definitions", () => {
  const cases = [
    [{ questions: [q({})] }, /title/],
    [{ title: "T", questions: [] }, /questions/],
    [{ title: "T", questions: [q({ type: "date" })] }, /type/],
    [{ title: "T", questions: [q({ label: "" })] }, /label/],
    [{ title: "T", questions: [q({ type: "choice", label: "x" })] }, /options/],
    [
      { title: "T", questions: [q({ type: "choice", label: "x", options: ["only"] })] },
      /options/,
    ],
    [{ title: "T", questions: [q({}), q({})] }, /duplicate/],
  ];
  for (const [body, re] of cases) {
    const result = normalizeDefinition(body, slugify, () => false);
    assert.match(result.error, re);
  }
});

test("slugify and uniqueness", () => {
  assert.equal(slugify("Weekly Check-in!"), "weekly-check-in");
  assert.equal(slugify("  --  "), "");
  let n = 0;
  const taken = () => n++ < 2;
  const result = normalizeDefinition({ title: "Demo", questions: [q({})] }, slugify, taken);
  assert.equal(result.form.slug, "demo-3");
});

test("answerError covers required, email, number, choice and rating", () => {
  const text = q({ required: true });
  assert.match(answerError(text, ""), /required/);
  assert.equal(answerError(text, " hi "), null);

  const email = q({ type: "email", required: true });
  assert.match(answerError(email, "nope"), /valid email/);
  assert.equal(answerError(email, "a@b.co"), null);

  const number = q({ type: "number" });
  assert.match(answerError(number, "abc"), /number/);
  assert.equal(answerError(number, "12.5"), null);
  assert.equal(answerError(number, ""), null, "optional number may be empty");

  const choice = q({ type: "choice", options: ["A", "B"] });
  assert.match(answerError(choice, "C"), /listed options/);
  assert.equal(answerError(choice, "A"), null);

  const rating = q({ type: "rating", max: 5 });
  assert.match(answerError(rating, 0), /between 1 and 5/);
  assert.match(answerError(rating, 6), /between 1 and 5/);
  assert.match(answerError(rating, 2.5), /between 1 and 5/);
  assert.equal(answerError(rating, 5), null);

  const optional = q({ required: false });
  assert.equal(answerError(optional, undefined), null);
});

test("validateAnswers rejects unknown question ids and returns the field", () => {
  const form = { questions: [q({ required: true })] };
  assert.deepEqual(validateAnswers(form, { answers: { nope: "x" } }).error, 'unknown question "nope"');
  const missing = validateAnswers(form, { answers: {} });
  assert.equal(missing.field, "q1");
  const good = validateAnswers(form, { answers: { q1: " hi " } });
  assert.deepEqual(good.answers, { q1: "hi" });
  const optionalForm = { questions: [q({ required: false })] };
  assert.deepEqual(
    validateAnswers(optionalForm, {}).answers,
    {},
    "missing answers object is treated as empty",
  );
});

test("number and rating answers must be numbers or numeric strings", () => {
  const number = q({ type: "number" });
  const rating = q({ type: "rating", max: 5 });

  // These all used to coerce: [] → 0, [4] → a rating, true → 1.
  for (const bad of [[], [4], { value: 5 }, true, false, [""]]) {
    assert.match(answerError(number, bad), /number/, `number rejects ${JSON.stringify(bad)}`);
    assert.match(answerError(rating, bad), /rating/, `rating rejects ${JSON.stringify(bad)}`);
  }

  // Real numeric shapes still pass, and convert to actual numbers.
  assert.equal(answerError(number, 42), null);
  assert.equal(answerError(number, " 42 "), null);
  assert.equal(answerError(rating, "4"), null);
  const converted = validateAnswers(
    { questions: [q({ type: "number", id: "n" }), q({ type: "rating", id: "r", max: 5 })] },
    { answers: { n: "12.5", r: 3 } },
  );
  assert.deepEqual(converted.answers, { n: 12.5, r: 3 });
  assert.equal(typeof converted.answers.n, "number");
});

test("answers are read as own properties, so inherited names never leak", () => {
  // A form whose id shadows an inherited name, with an optional question left
  // unanswered: the absent answer must read as absent, not as the inherited
  // "function Object() { [native code] }".
  const form = {
    questions: [
      { id: "constructor", type: "text", label: "Text?", required: true },
      { id: "toString", type: "text", label: "More?", required: false },
    ],
  };
  const result = validateAnswers(form, { answers: { constructor: "real answer" } });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.answers, { constructor: "real answer" });
  // The unanswered question's key never exists as an own property (the "in"
  // check would see the inherited one; only own properties are stored).
  assert.ok(!Object.hasOwn(result.answers, "toString"));
});

test("__proto__ is rejected as a question id at definition time", () => {
  const result = normalizeDefinition(
    { title: "Trap", questions: [{ id: "__proto__", type: "text", label: "Name?" }] },
    slugify,
    () => false,
  );
  assert.match(result.error, /__proto__/);

  // Even a forged submission cannot smuggle the key past unknown-id checks.
  // The wire shape is raw JSON: JSON.parse makes "__proto__" an own property,
  // which is exactly how the server sees an attacker's body.
  const form = { questions: [q({ required: true })] };
  const forged = JSON.parse('{"answers":{"__proto__":"x"}}');
  assert.deepEqual(
    validateAnswers(form, forged).error,
    'unknown question "__proto__"',
  );
});
