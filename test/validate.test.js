// Unit tests for definition and answer validation.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDefinition, normalizeUpdate, answerError, validateAnswers } = require("../lib/validate");
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

test("question ids that would collide with object internals are rejected", () => {
  const bad = ["__proto__", "CONSTRUCTOR", "prototype", "a b", "x".repeat(65)];
  for (const id of bad) {
    const result = normalizeDefinition({ title: "T", questions: [q({ id })] }, slugify, () => false);
    assert.match(result.error, /id must be/, `id "${id.slice(0, 20)}" must be rejected`);
  }
  const good = normalizeDefinition({ title: "T", questions: [q({ id: "budget-2026_Q1" })] }, slugify, () => false);
  assert.equal(good.error, undefined);
});

test("numeric answers must be numbers or numeric strings, nothing else", () => {
  const number = q({ type: "number", required: true });
  assert.match(answerError(number, []), /number/, "an empty array is not a number");
  assert.match(answerError(number, [5]), /number/, "a wrapped number is not a number");
  assert.match(answerError(number, true), /number/, "a boolean is not a number");
  assert.match(answerError(number, { v: 5 }), /number/, "an object is not a number");
  assert.match(answerError(number, NaN), /number/);
  assert.equal(answerError(number, 5), null);
  assert.equal(answerError(number, "12.5"), null);

  const rating = q({ type: "rating", max: 5 });
  assert.match(answerError(rating, [3]), /between 1 and 5/);
  assert.equal(answerError(rating, 3), null);

  // A rejected answer never reaches the stored response.
  const form = { questions: [number] };
  const rejected = validateAnswers(form, { answers: { q1: [] } });
  assert.ok(rejected.error);
  const accepted = validateAnswers(form, { answers: { q1: "12" } });
  assert.deepEqual({ ...accepted.answers }, { q1: 12 });
});

test("normalizeUpdate validates partial edits and never touches the slug", () => {
  const current = {
    slug: "weekly-check-in",
    title: "Weekly Check-in",
    description: "",
    published: true,
    questions: [q({})],
  };
  const titleOnly = normalizeUpdate({ title: "Renamed" });
  assert.equal(titleOnly.error, undefined);
  assert.deepEqual(Object.keys(titleOnly.fields), ["title", "updatedAt"]);

  const reorder = normalizeUpdate({
    questions: [q({ id: "q2", type: "email", label: "Email?" }), q({ id: "q1", type: "text", label: "Name?" })],
  });
  assert.equal(reorder.error, undefined);
  assert.equal(reorder.fields.questions[0].id, "q2");

  const publish = normalizeUpdate({ published: false });
  assert.equal(publish.fields.published, false);

  const noSlug = normalizeUpdate({ slug: "hijacked", title: "Renamed" });
  assert.equal(noSlug.fields.slug, undefined, "the slug is identity");

  assert.match(normalizeUpdate({}).error, /nothing to update/);
  assert.match(normalizeUpdate({ title: "" }).error, /title/);
  assert.match(normalizeUpdate({ questions: [] }).error, /questions/);
  assert.match(normalizeUpdate({ questions: [q({ id: "__proto__" })] }).error, /id must be/);
  assert.match(normalizeUpdate("nope").error, /JSON object/);
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
  assert.deepEqual({ ...good.answers }, { q1: "hi" });
  const optionalForm = { questions: [q({ required: false })] };
  assert.deepEqual(
    { ...validateAnswers(optionalForm, {}).answers },
    {},
    "missing answers object is treated as empty",
  );
});

test("a forged __proto__ answer cannot slip past the unknown-id check", () => {
  // The wire shape is raw JSON: JSON.parse makes "__proto__" an own property,
  // which is exactly how the server sees an attacker's body — and it is
  // rejected as an unknown question rather than leaking into the answers.
  const form = { questions: [q({ required: true })] };
  const forged = JSON.parse('{"answers":{"__proto__":"x"}}');
  assert.deepEqual(
    validateAnswers(form, forged).error,
    'unknown question "__proto__"',
  );
});
