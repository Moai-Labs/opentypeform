// Sign-in / sign-up. Plain JavaScript, no build step.
//
// The email address is the sign-in credential only — there is no mail
// service in this stack, so nothing is sent to it and nothing is verified.
"use strict";

(function () {
  const app = document.getElementById("app");

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const json = (method, body) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Already signed in? Go straight to the dashboard.
  fetch("/api/me")
    .then(async (r) => {
      if (r.ok) return (location.href = "/dashboard");
      render("login");
    });

  function render(mode) {
    const isSignup = mode === "signup";
    const email = el("input");
    email.type = "email";
    email.name = "email";
    email.placeholder = "you@example.com";
    email.autocomplete = "email";
    const password = el("input");
    password.type = "password";
    password.name = "password";
    password.placeholder = isSignup ? "At least 8 characters" : "Your password";
    password.autocomplete = isSignup ? "new-password" : "current-password";
    const error = el("p", "error");
    const btn = el("button", "primary", isSignup ? "Create account" : "Sign in");
    btn.type = "button";

    async function go() {
      error.textContent = "";
      const path = isSignup ? "/api/auth/signup" : "/api/auth/login";
      const r = await fetch(path, json("POST", { email: email.value, password: password.value }));
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        error.textContent = body.error || "That did not work — try again.";
        return;
      }
      location.href = "/dashboard";
    }

    btn.addEventListener("click", go);
    const form = el("form", "auth-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      go();
    });
    form.append(
      el("h1", null, isSignup ? "Create your account" : "Sign in"),
      el("p", "muted", isSignup
        ? "Own your forms, collect responses, and upgrade when you outgrow the free plan."
        : "Welcome back."),
      email,
      password,
      btn,
      error,
    );

    const toggle = el("button", "link", isSignup
      ? "I already have an account — sign in"
      : "New here? Create an account");
    toggle.type = "button";
    toggle.addEventListener("click", () => render(isSignup ? "login" : "signup"));

    app.replaceChildren(form, toggle, el("p", "muted small", "Your email is only the sign-in credential. Nothing is ever sent to it."));
  }
})();
