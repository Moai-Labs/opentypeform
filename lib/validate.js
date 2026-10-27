// Validation for form definitions (owner API) and for answers (public API).
"use strict";

const QUESTION_TYPES = ["text", "email", "number", "choice", "rating"];
const MAX_QUESTIONS = 50;
const MAX_OPTIONS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Answers accumulate in plain objects, so a question id of "__proto__" could
// never hold an answer: the assignment hits the prototype setter instead of
// creating an own property, and the answer is silently dropped. That id is
// rejected outright. Ids that merely shadow inherited names ("constructor",
// "toString", …) stay legal because every answer read is own-property checked
// (Object.hasOwn) and the runner keeps its dictionaries null-prototype.
const UNSAFE_IDS = new Set(["__proto__"]);

// --- form definitions ---

// Normalises a submitted definition into the shape we store, or returns
// { error } with a human-readable message.
function normalizeDefinition(body, slugify, isSlugTaken) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }
  const title = str(body.title).trim();
  if (!title || title.length > 120) {
    return { error: "title is required and must be at most 120 characters" };
  }
  const description = str(body.description).slice(0, 500);
  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    return { error: "questions must be a non-empty array" };
  }
  if (body.questions.length > MAX_QUESTIONS) {
    return { error: `at most ${MAX_QUESTIONS} questions per form` };
  }

  const questions = [];
  const seenIds = new Set();
  for (const [i, q] of body.questions.entries()) {
    const err = normalizeQuestion(q, i, seenIds);
    if (err) return { error: err };
    // normalizeQuestion mutates a copy it pushed indirectly; rebuild here.
    questions.push(buildQuestion(q, i, seenIds));
  }

  let slug = slugify(title);
  if (!slug) slug = "form";
  let candidate = slug;
  for (let n = 2; isSlugTaken(candidate); n++) candidate = `${slug}-${n}`;

  return {
    form: {
      slug: candidate,
      title,
      description,
      published: body.published === undefined ? true : Boolean(body.published),
      questions,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function normalizeQuestion(q, i, seenIds) {
  if (typeof q !== "object" || q === null || Array.isArray(q)) {
    return `questions[${i}] must be an object`;
  }
  if (!QUESTION_TYPES.includes(q.type)) {
    return `questions[${i}].type must be one of: ${QUESTION_TYPES.join(", ")}`;
  }
  const label = str(q.label).trim();
  if (!label || label.length > 300) {
    return `questions[${i}].label is required and must be at most 300 characters`;
  }
  if (q.type === "choice") {
    if (!Array.isArray(q.options) || q.options.length < 2) {
      return `questions[${i}] (choice) needs at least 2 options`;
    }
    if (q.options.length > MAX_OPTIONS) {
      return `questions[${i}] (choice) allows at most ${MAX_OPTIONS} options`;
    }
    if (q.options.some((o) => !str(o).trim())) {
      return `questions[${i}] (choice) options must be non-empty`;
    }
  }
  const qid = str(q.id).trim() || `q${i + 1}`;
  if (UNSAFE_IDS.has(qid)) {
    return `questions[${i}].id "${qid}" is reserved and cannot be used as a question id`;
  }
  if (seenIds.has(qid)) return `duplicate question id "${qid}"`;
  seenIds.add(qid);
  return null;
}

function buildQuestion(q, i, seenIds) {
  const question = {
    id: str(q.id).trim() || `q${i + 1}`,
    type: q.type,
    label: str(q.label).trim(),
    required: Boolean(q.required),
  };
  if (q.type === "choice") {
    question.options = q.options.map((o) => str(o).trim());
  }
  if (q.type === "text") {
    question.multiline = Boolean(q.multiline);
  }
  if (q.type === "rating") {
    question.max = Math.min(Math.max(Number(q.max) || 5, 2), 10);
  }
  if (str(q.placeholder).trim()) {
    question.placeholder = str(q.placeholder).trim().slice(0, 120);
  }
  if (str(q.description).trim()) {
    question.description = str(q.description).trim().slice(0, 300);
  }
  return question;
}

// --- answers ---

// Returns null when the answer is acceptable, otherwise a short message.
function answerError(question, value) {
  const empty =
    value === undefined || value === null || (typeof value === "string" && value.trim() === "");

  if (empty) return question.required ? "This question is required." : null;

  switch (question.type) {
    case "text":
      if (typeof value !== "string") return "Please answer with text.";
      if (value.trim().length > 2000) return "Answer is too long (max 2000 characters).";
      return null;
    case "email":
      if (typeof value !== "string" || !EMAIL_RE.test(value.trim())) {
        return "Please enter a valid email address.";
      }
      return null;
    case "number": {
      // Numbers and ratings must arrive as JSON numbers or numeric strings;
      // arrays, objects and booleans are never numeric answers, no matter
      // what coercing them through String/Number would produce.
      if (!isNumericAnswer(value)) return "Please enter a number.";
      const n = Number(String(value).trim());
      if (!Number.isFinite(n)) return "Please enter a number.";
      if (Math.abs(n) > 1e15) return "Number is too large.";
      return null;
    }
    case "choice": {
      if (typeof value !== "string") return "Please pick one option.";
      if (!question.options.includes(value)) return "Please pick one of the listed options.";
      return null;
    }
    case "rating": {
      if (!isNumericAnswer(value)) {
        return `Please pick a rating between 1 and ${question.max || 5}.`;
      }
      const n = Number(String(value).trim());
      if (!Number.isInteger(n) || n < 1 || n > (question.max || 5)) {
        return `Please pick a rating between 1 and ${question.max || 5}.`;
      }
      return null;
    }
    default:
      return "Unsupported question type.";
  }
}

// Validates a full answers object against a form. Returns
// { answers } with cleaned values, or { error, field } on the first problem.
function validateAnswers(form, body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }
  const raw = typeof body.answers === "object" && body.answers !== null ? body.answers : {};
  const known = new Set(form.questions.map((q) => q.id));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { error: `unknown question "${key}"`, field: key };
  }

  const answers = {};
  for (const q of form.questions) {
    // Own-property lookup: an absent answer and an inherited value like
    // Object.prototype.constructor must never be confused.
    const value = Object.hasOwn(raw, q.id) ? raw[q.id] : undefined;
    const err = answerError(q, value);
    if (err) return { error: err, field: q.id };
    const empty =
      value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    if (!empty) answers[q.id] = q.type === "number" || q.type === "rating" ? Number(value) : String(value).trim();
  }
  return { answers };
}

// True when a value is a JSON number or a non-empty string — the only shapes
// that may be converted into a number/rating answer.
function isNumericAnswer(value) {
  return typeof value === "number" || (typeof value === "string" && value.trim() !== "");
}

function str(value) {
  return typeof value === "string" ? value : "";
}

module.exports = { QUESTION_TYPES, normalizeDefinition, answerError, validateAnswers };
