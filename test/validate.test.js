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
