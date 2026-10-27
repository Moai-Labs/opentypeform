// Billing: plans, usage, and paying for the paid plan in test USDC.
//
// Every payment on this page is a test: the money is test USDC on a public
// testnet, and the page says so everywhere money appears. Paying starts a
// payment record with its own receiving address; the server watches that
// address on the chain and lifts the limits the moment the right amount
// arrives — no third-party payment service, verified in the product itself.
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

  let me = null;

  init();

  async function init() {
    const r = await fetch("/api/me");
    if (!r.ok) return (location.href = "/login");
    me = await r.json();
    const status = await fetch("/api/billing/status").then((r) => r.json());
    render(status);
  }

  function usageLine(plan) {
    return `${plan.used} of ${plan.limit} responses used this month`;
  }

  function render(status) {
    const plan = status.plan || me.plan;
    const paid = plan.tier === "paid";

    const head = el("div", "list-head");
    head.append(el("h1", null, "Billing"));
    head.append(el("span", "pill", paid ? "Pro" : "Free plan"));

    const usage = el("p", null, usageLine(plan));
    usage.className = "usage";
    const when = el("p", "muted small");
    if (paid) {
      when.textContent = `Pro is active until ${new Date(plan.paidUntil).toLocaleDateString()} — each payment adds 30 days.`;
    }

    const cards = el("div", "plans");
    cards.append(planCard("Free", "$0", ["25 responses a month", "Branded forms — the runner shows “Built with OpenTypeform”"], plan.tier === "free"));
    cards.append(planCard("Pro", `$${plan.priceUsdc}/month`, ["1,000 responses a month", "Unbranded forms — your words only"], plan.tier === "paid"));

    const children = [head, usage, when, cards];

    if (paid) {
      // Still show the renewal panel: a new payment adds another 30 days
      // whenever the current window is close to its end.
      children.append(paymentPanel(status, "Extend Pro with another 30 days"));
    } else {
      children.append(el("p", "error", plan.used >= plan.limit ? "Collection is paused — you have used every response your free plan allows this month. Pay below to lift the limit immediately." : ""));
      children.append(paymentPanel(status, "Upgrade to Pro"));
    }

    app.replaceChildren(...children.filter(Boolean));
  }

  function planCard(name, price, features, current) {
    const card = el("div", "plan-card" + (current ? " current" : ""));
    const head = el("div", "plan-head");
    head.append(el("strong", null, name), el("span", "plan-price", price));
    if (current) head.append(el("span", "pill", "Current"));
    card.append(head);
    const list = el("ul");
    for (const f of features) list.append(el("li", null, f));
    card.append(list);
    return card;
  }

  // The payment panel: start a payment, then show the address and wait. The
  // status line below is what the server verifies — it watches the chain so
  // the page does not have to.
  function paymentPanel(status, label) {
    const panel = el("div", "pay-panel");

    const test = el("p", "test-note", "TEST PAYMENT — test USDC on a public testnet. Nothing real changes hands; this exists so the product can be tried end to end.");
    panel.append(test);

    const pay = el("button", "primary", label);
    pay.type = "button";
    const info = el("div", "pay-info");
    const state = el("p", "muted");

    async function start() {
      pay.disabled = true;
      const r = await fetch("/api/billing/start", json("POST", {}));
      const body = await r.json().catch(() => ({}));
      pay.disabled = false;
      if (!r.ok) {
        state.textContent = body.error || "Could not start a payment — try again.";
        return;
      }
      showPayment(body);
      poll();
    }

    function showPayment(details) {
      info.replaceChildren(
        el("p", null, "Send exactly this payment from any wallet:"),
        row("Amount", `${details.amountUsdc} USDC`),
        row("Network", `${details.network} (chain ${details.chainId})`),
        row("Token", "USDC (test)"),
        row("To", addressEl(details.address)),
      );
      state.textContent = "Waiting for the payment to arrive on-chain…";
    }

    async function poll() {
      try {
        const s = await fetch("/api/billing/status").then((r) => r.json());
        if (s.lastCheckError) {
          state.textContent = "Could not reach the chain just now — still trying.";
        } else if (s.awaiting) {
          showPayment(s.awaiting);
          if (s.plan) state.textContent = `Waiting for the payment… ${s.plan.used} of ${s.plan.limit} responses used this month.`;
        } else if (s.plan && s.plan.tier === "paid") {
          state.textContent = "Payment confirmed on-chain — the limits are lifted. Thank you!";
          pay.remove();
          refreshSoon();
          return;
        }
      } catch {
        state.textContent = "Network hiccup — still trying.";
      }
      setTimeout(poll, 5_000);
    }

    async function refreshSoon() {
      // Reload the plan cards so "Current" moves to Pro.
      setTimeout(() => location.reload(), 1_500);
    }

    pay.addEventListener("click", start);
    panel.append(pay, info, state);
    // A payment may already be in flight from an earlier visit.
    if (status.awaiting) {
      showPayment(status.awaiting);
      poll();
    }
    return panel;
  }

  function row(label, value) {
    const line = el("p", "pay-row");
    line.append(el("span", "pay-label", label));
    line.append(value);
    return line;
  }

  function addressEl(address) {
    const code = el("code", "pay-address", address);
    const copy = el("button", "link", "Copy");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(address);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select and copy";
      }
    });
    const wrap = el("span");
    wrap.append(code, " ", copy);
    return wrap;
  }
})();
