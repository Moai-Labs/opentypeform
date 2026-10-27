// The seeded starting template: one ready-made published form so a first
// form takes minutes. Seeded exactly once, on first boot.
"use strict";

const { id } = require("./store");

const TEMPLATE_SLUG = "enquiry";

function templateForm() {
  return {
    id: id(),
    slug: TEMPLATE_SLUG,
    title: "Client enquiry",
    description:
      "A short enquiry form for independent consultants and small businesses. Edit or replace it once the builder lands — for now it shows what a finished form feels like.",
    published: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    questions: [
      {
        id: "q1",
        type: "text",
        label: "What's your name?",
        required: true,
        placeholder: "Ada Lovelace",
      },
      {
        id: "q2",
        type: "email",
        label: "What's the best email to reach you?",
        required: true,
        placeholder: "you@example.com",
      },
      {
        id: "q3",
        type: "choice",
        label: "What do you need help with?",
        required: true,
        options: ["Strategy", "Design", "Development", "Something else"],
      },
      {
        id: "q4",
        type: "number",
        label: "What's your budget, in USD?",
        required: false,
        description: "A rough range is fine — skip if you'd rather talk first.",
        placeholder: "5000",
      },
      {
        id: "q5",
        type: "text",
        label: "Tell us a little about the project.",
        required: true,
        multiline: true,
        placeholder: "What are you building, and by when?",
      },
      {
        id: "q6",
        type: "rating",
        label: "How urgent is this?",
        required: false,
        max: 5,
        description: "1 = can wait, 5 = yesterday",
      },
    ],
  };
}

// Seeds the template on first initialization only, marked durably in the
// store's meta. An empty store that has already been initialized — the owner
// deleted every form — stays empty. Returns the seeded form, or null when
// there was nothing to do.
function seedIfNeeded(store) {
  if (store.getMeta("seeded")) return null;
  const seeded = store.addForm(templateForm());
  store.setMeta("seeded", true);
  return seeded;
}

module.exports = { templateForm, seedIfNeeded, TEMPLATE_SLUG };
