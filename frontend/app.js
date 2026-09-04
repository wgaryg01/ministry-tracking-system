const API = ""; // same origin

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    credentials: "same-origin",
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const detail = body && body.detail ? body.detail : `Request failed (${res.status})`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function msg(text, kind = "info") {
  return el("div", { class: `msg ${kind}`, text });
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

let _categoryOptionsCache = null;
async function categoryDatalist(id) {
  const datalist = el("datalist", { id });
  try {
    if (!_categoryOptionsCache) _categoryOptionsCache = await api("/activities/categories");
    for (const c of _categoryOptionsCache) datalist.appendChild(el("option", { value: c }));
  } catch (e) { /* no categories yet — fine */ }
  return datalist;
}

let _teammemberCache = null;
async function getTeammembers() {
  if (!_teammemberCache) {
    try { _teammemberCache = await api("/users?role=teammember"); }
    catch (e) { _teammemberCache = []; }
  }
  return _teammemberCache;
}

const OFFSET_PRESETS = [
  { label: "1 hour before", minutes: 60 },
  { label: "1 day before", minutes: 1440 },
  { label: "1 week before", minutes: 10080 },
];

function offsetLabel(minutes) {
  if (minutes % 10080 === 0) return `${minutes / 10080} week${minutes / 10080 !== 1 ? "s" : ""} before`;
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes / 1440 !== 1 ? "s" : ""} before`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes / 60 !== 1 ? "s" : ""} before`;
  return `${minutes} minutes before`;
}

/**
 * Builds the shared notes/status/scheduling/assignment/notification
 * fields used by every activity form (new person, add activity, edit
 * activity). Returns { root, getValues() } — the caller merges
 * getValues() into whatever payload it's posting.
 */
async function buildSchedulingSection(existing = {}) {
  const root = el("div");

  const notesInput = el("textarea", { placeholder: "What was done, or what needs to be done" });
  notesInput.value = existing.notes || "";
  root.appendChild(el("div", { class: "field" }, [el("label", { text: "Notes" }), notesInput]));

  const statusSelect = el("select", {}, [
    el("option", { value: "completed", text: "Completed" }),
    el("option", { value: "scheduled", text: "Scheduled (future)" }),
    el("option", { value: "cancelled", text: "Cancelled" }),
  ]);
  statusSelect.value = existing.status || "completed";
  root.appendChild(el("div", { class: "field" }, [el("label", { text: "Status" }), statusSelect]));

  const scheduledWrap = el("div", { class: existing.status === "scheduled" ? "" : "hidden" });
  const scheduledAtInput = el("input", { type: "datetime-local" });
  if (existing.scheduled_at) scheduledAtInput.value = existing.scheduled_at.slice(0, 16);
  scheduledWrap.appendChild(el("div", { class: "field" }, [el("label", { text: "Scheduled for" }), scheduledAtInput]));

  const assignWrap = el("div");
  assignWrap.appendChild(el("label", { text: "Assign team members" }));
  const assignBoxes = el("div");
  assignWrap.appendChild(assignBoxes);
  const existingAssignedIds = new Set((existing.assigned_to || []).map((u) => u.id));
  const teammembers = await getTeammembers();
  const checkboxes = [];
  for (const tm of teammembers) {
    const cb = el("input", { type: "checkbox", value: tm.id });
    if (existingAssignedIds.has(tm.id)) cb.checked = true;
    checkboxes.push(cb);
    const label = el("label", {}, [cb, ` ${tm.email}`]);
    label.style.display = "block";
    assignBoxes.appendChild(label);
  }
  scheduledWrap.appendChild(assignWrap);

  let offsetMinutes = [...(existing.notification_offsets_minutes || [])];
  const offsetList = el("ul", { class: "address-history" });
  const renderOffsets = () => {
    offsetList.innerHTML = "";
    for (const m of offsetMinutes) {
      const removeBtn = el("button", { class: "link-btn", type: "button", text: " remove" });
      removeBtn.addEventListener("click", () => {
        offsetMinutes = offsetMinutes.filter((x) => x !== m);
        renderOffsets();
      });
      offsetList.appendChild(el("li", {}, [offsetLabel(m), removeBtn]));
    }
  };
  renderOffsets();

  const presetRow = el("div", { class: "field-row" });
  for (const preset of OFFSET_PRESETS) {
    const btn = el("button", { class: "secondary", type: "button", text: `+ ${preset.label}` });
    btn.addEventListener("click", () => {
      if (!offsetMinutes.includes(preset.minutes)) {
        offsetMinutes.push(preset.minutes);
        renderOffsets();
      }
    });
    presetRow.appendChild(btn);
  }

  const customAmount = el("input", { type: "number", min: "1", placeholder: "e.g. 3" });
  const customUnit = el("select", {}, [
    el("option", { value: "60", text: "hours" }),
    el("option", { value: "1440", text: "days" }),
    el("option", { value: "1", text: "minutes" }),
  ]);
  const customAddBtn = el("button", { class: "secondary", type: "button", text: "+ Add custom" });
  customAddBtn.addEventListener("click", () => {
    const n = parseInt(customAmount.value, 10);
    if (n > 0) {
      const minutes = n * parseInt(customUnit.value, 10);
      if (!offsetMinutes.includes(minutes)) {
        offsetMinutes.push(minutes);
        renderOffsets();
      }
      customAmount.value = "";
    }
  });

  scheduledWrap.appendChild(el("div", { class: "field" }, [
    el("label", { text: "Notify assigned team members" }),
    offsetList,
    presetRow,
    el("div", { class: "field-row" }, [customAmount, customUnit, customAddBtn]),
  ]));

  root.appendChild(scheduledWrap);

  statusSelect.addEventListener("change", () => {
    scheduledWrap.classList.toggle("hidden", statusSelect.value !== "scheduled");
  });

  return {
    root,
    getValues: () => ({
      notes: notesInput.value || null,
      status: statusSelect.value,
      scheduled_at: statusSelect.value === "scheduled" && scheduledAtInput.value ? scheduledAtInput.value : null,
      assigned_user_ids: checkboxes.filter((cb) => cb.checked).map((cb) => cb.value),
      notification_offsets_minutes: statusSelect.value === "scheduled" ? offsetMinutes : [],
    }),
  };
}

const main = document.getElementById("app-main");
const header = document.getElementById("app-header");
let currentUser = null;
let currentOrg = null;

function setHeader(user, org) {
  if (!user) { header.classList.add("hidden"); return; }
  header.classList.remove("hidden");
  document.getElementById("user-email").textContent = user.full_name || user.email;
  document.getElementById("user-role").textContent = user.role;
  document.getElementById("brand-name").textContent = org.ministry_name;
  const logoEl = document.getElementById("brand-logo");
  if (org.has_logo) {
    logoEl.src = "/org/logo";
    logoEl.hidden = false;
  }
}

document.getElementById("sign-out-btn").addEventListener("click", async () => {
  await api("/auth/logout", { method: "POST" });
  window.location.href = "/";
});

async function loadOrgSettings() {
  try { return await api("/org/settings"); }
  catch (e) { return { ministry_name: "Mission Home", has_logo: false }; }
}

// ---------- Sign-in view ----------

function renderSignIn(org) {
  header.classList.add("hidden");
  main.innerHTML = "";
  const shell = el("div", { class: "signin-shell" });
  if (org.has_logo) shell.appendChild(el("img", { class: "brand-logo-large", src: "/org/logo", alt: "" }));
  shell.appendChild(el("h1", { text: org.ministry_name }));
  shell.appendChild(el("p", { class: "lead", text: "Sign in with your username and password. We'll also send a verification link to confirm it's you." }));

  const feedback = el("div");
  const usernameInput = el("input", { type: "text", placeholder: "Username", required: "true" });
  const passwordInput = el("input", { type: "password", placeholder: "Password", required: "true" });
  const submitBtn = el("button", { class: "primary", text: "Sign in" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: usernameInput.value, password: passwordInput.value }),
      });
      feedback.appendChild(msg("Check your email (and phone, if you've opted in) for a verification link. It expires in 15 minutes.", "success"));
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
    } finally {
      submitBtn.removeAttribute("disabled");
    }
  }});
  form.appendChild(el("div", { class: "field" }, [usernameInput]));
  form.appendChild(el("div", { class: "field" }, [passwordInput]));
  form.appendChild(submitBtn);

  shell.appendChild(form);
  shell.appendChild(feedback);

  // Bootstrap path — only works for accounts that haven't finished
  // first-time setup yet (right after being invited).
  const bootstrapToggle = el("button", { class: "link-btn", text: "First time signing in?" });
  const bootstrapWrap = el("div", { class: "hidden" });
  bootstrapToggle.addEventListener("click", () => bootstrapWrap.classList.toggle("hidden"));

  const bsFeedback = el("div");
  const emailInput = el("input", { type: "email", placeholder: "you@example.com", required: "true" });
  const bsSubmitBtn = el("button", { class: "secondary", text: "Send setup link" });
  const bsForm = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    bsSubmitBtn.setAttribute("disabled", "true");
    bsFeedback.innerHTML = "";
    try {
      await api("/auth/magic-link", { method: "POST", body: JSON.stringify({ email: emailInput.value }) });
      bsFeedback.appendChild(msg("If that email has an account awaiting setup, a link has been sent.", "success"));
    } catch (err) {
      bsFeedback.appendChild(msg(err.message, "error"));
    } finally {
      bsSubmitBtn.removeAttribute("disabled");
    }
  }});
  bsForm.appendChild(el("div", { class: "field" }, [el("label", { text: "Email you were invited with" }), emailInput]));
  bsForm.appendChild(bsSubmitBtn);
  bootstrapWrap.appendChild(bsForm);
  bootstrapWrap.appendChild(bsFeedback);

  shell.appendChild(bootstrapToggle);
  shell.appendChild(bootstrapWrap);

  main.appendChild(shell);
}

// ---------- Verify (landing from email link) ----------

async function renderVerify() {
  main.innerHTML = "";
  const shell = el("div", { class: "signin-shell" });
  const status = msg("Signing you in…", "info");
  shell.appendChild(status);
  main.appendChild(shell);

  const token = new URLSearchParams(window.location.search).get("token");
  if (!token) {
    status.className = "msg error";
    status.textContent = "No sign-in token found. Please use the link from your email.";
    return;
  }
  try {
    await api(`/auth/verify?token=${encodeURIComponent(token)}`);
    window.history.replaceState({}, "", "/");
    await boot();
  } catch (err) {
    status.className = "msg error";
    status.textContent = err.message;
  }
}

// ---------- People list (home view) ----------

function statCell(cls, value, extraCls = "") {
  return el("span", { class: `stat-col ${cls} ${extraCls}`.trim(), text: money(value) });
}

async function renderPeopleSection(onNavigate) {
  const section = el("section");
  section.appendChild(el("h2", { text: "People assisted" }));

  const body = el("div");
  section.appendChild(body);

  try {
    const data = await api("/people");

    const strip = el("div", { class: "totals-strip" });
    for (const [label, key] of [["This month", "month_total"], ["This quarter", "quarter_total"], ["Fiscal YTD", "year_total"], ["All time", "all_time_total"]]) {
      strip.appendChild(el("div", { class: "stat" }, [
        el("span", { class: "label", text: label }),
        el("span", { class: "value", text: money(data.org_totals[key]) }),
      ]));
    }
    body.appendChild(strip);

    if (data.people.length === 0) {
      body.appendChild(el("div", { class: "empty-state", text: "No one has been assisted yet." }));
      return section;
    }

    const head = el("div", { class: "people-table-head" }, [
      el("span", { class: "who", text: "Person" }),
      el("span", { class: "stat-col", text: "Month" }),
      el("span", { class: "stat-col", text: "Quarter" }),
      el("span", { class: "stat-col", text: "FY" },),
      el("span", { class: "stat-col all-time", text: "All time" }),
    ]);
    body.appendChild(head);

    const table = el("div", { class: "people-table" });
    for (const p of data.people) {
      const label = p.name || "Hidden";
      const row = el("button", {
        class: "people-row",
        onclick: () => onNavigate(p.identity_id),
      }, [
        el("span", { class: "who", text: label }),
        statCell("", p.month_total),
        statCell("", p.quarter_total),
        statCell("", p.year_total),
        statCell("all-time", p.all_time_total, "all-time"),
      ]);
      table.appendChild(row);
    }
    body.appendChild(table);
  } catch (err) {
    body.appendChild(msg(err.message, "error"));
  }
  return section;
}

// ---------- Person detail view ----------

async function renderAddActivityForm(identityId, onLogged) {
  const feedback = el("div");
  const amountInput = el("input", { type: "number", step: "0.01", min: "0", placeholder: "0.00" });
  const categoryInput = el("input", { type: "text", list: "category-options-detail", placeholder: "e.g. groceries, utilities, rent" });
  const dateInput = el("input", { type: "date" });
  const submitBtn = el("button", { class: "primary", text: "Add activity" });
  const scheduling = await buildSchedulingSection();

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      await api("/activities", {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          amount_spent: amountInput.value ? parseFloat(amountInput.value) : null,
          category: categoryInput.value || null,
          activity_date: dateInput.value || null,
          ...scheduling.getValues(),
        }),
      });
      feedback.appendChild(msg("Logged.", "success"));
      form.reset();
      _categoryOptionsCache = null;
      if (onLogged) onLogged();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
    } finally {
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Amount" }), amountInput]),
    el("div", { class: "field" }, [el("label", { text: "Category" }), categoryInput]),
    el("div", { class: "field" }, [el("label", { text: "Date" }), dateInput]),
  ]));
  form.appendChild(scheduling.root);
  form.appendChild(submitBtn);

  const wrap = el("div");
  categoryDatalist("category-options-detail").then((dl) => wrap.appendChild(dl));
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function renderAddHouseholdMemberForm(identityId, onAdded) {
  const feedback = el("div");
  const typeSelect = el("select", {}, [
    el("option", { value: "adult", text: "Adult" }),
    el("option", { value: "child", text: "Child" }),
  ]);
  const nameInput = el("input", { type: "text", required: "true", placeholder: "Name" });
  const ageInput = el("input", { type: "number", min: "0", placeholder: "Age" });
  const relInput = el("input", { type: "text", placeholder: "Relationship to applicant" });
  const submitBtn = el("button", { class: "secondary", text: "Add household member" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      await api(`/identities/${identityId}/household`, {
        method: "POST",
        body: JSON.stringify({
          member_type: typeSelect.value,
          name: nameInput.value,
          age: ageInput.value ? parseInt(ageInput.value, 10) : null,
          relationship: relInput.value || null,
        }),
      });
      form.reset();
      if (onAdded) onAdded();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Type" }), typeSelect]),
    el("div", { class: "field" }, [el("label", { text: "Name" }), nameInput]),
    el("div", { class: "field" }, [el("label", { text: "Age" }), ageInput]),
    el("div", { class: "field" }, [el("label", { text: "Relationship" }), relInput]),
  ]));
  form.appendChild(submitBtn);

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function renderRecordMoveForm(identityId, onRecorded) {
  const feedback = el("div");
  const addressInput = el("input", { type: "text", required: "true", placeholder: "New address" });
  const dateInput = el("input", { type: "date" });
  const submitBtn = el("button", { class: "secondary", text: "Record move" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      await api(`/identities/${identityId}/addresses`, {
        method: "POST",
        body: JSON.stringify({ address: addressInput.value, effective_date: dateInput.value || null }),
      });
      feedback.appendChild(msg("Address updated.", "success"));
      form.reset();
      if (onRecorded) onRecorded();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
    } finally {
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "New address" }), addressInput]),
    el("div", { class: "field" }, [el("label", { text: "Effective date" }), dateInput]),
  ]));
  form.appendChild(submitBtn);

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function renderEditIdentityForm(identityId, data, onSaved) {
  const feedback = el("div");
  const nameInput = el("input", { type: "text", required: "true", value: data.name || "" });
  const dobInput = el("input", { type: "date", value: data.dob || "" });
  const contactInput = el("input", { type: "text", value: data.contact_info || "" });
  const notesInput = el("textarea", { text: data.notes || "" });
  const submitBtn = el("button", { class: "primary", text: "Save changes" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      await api(`/identities/${identityId}`, {
        method: "PUT",
        body: JSON.stringify({
          full_name: nameInput.value,
          dob: dobInput.value || null,
          contact_info: contactInput.value || null,
          notes: notesInput.value || null,
        }),
      });
      if (onSaved) onSaved();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Full name" }), nameInput]));
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Date of birth" }), dobInput]),
    el("div", { class: "field" }, [el("label", { text: "Phone" }), contactInput]),
  ]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Notes" }), notesInput]));
  form.appendChild(submitBtn);

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function renderAccessHistorySection(identityId) {
  const section = el("section");
  const toggle = el("button", { class: "link-btn", text: "Show access history" });
  const body = el("div", { class: "hidden" });
  let loaded = false;

  toggle.addEventListener("click", async () => {
    const nowHidden = body.classList.toggle("hidden");
    toggle.textContent = nowHidden ? "Show access history" : "Hide access history";
    if (!nowHidden && !loaded) {
      loaded = true;
      try {
        const logs = await api(`/identities/${identityId}/logs`);
        if (logs.length === 0) {
          body.appendChild(el("div", { class: "empty-state", text: "No recorded access yet." }));
        } else {
          const list = el("div", { class: "ledger" });
          for (const l of logs) {
            list.appendChild(el("div", { class: "ledger-row" }, [
              el("span", { class: "date", text: new Date(l.created_at).toLocaleString() }),
              el("span", { class: "category", text: `${l.action} \u2014 ${l.user_email}` }),
            ]));
          }
          body.appendChild(list);
        }
      } catch (err) {
        body.appendChild(msg(err.message, "error"));
      }
    }
  });

  section.appendChild(toggle);
  section.appendChild(body);
  return section;
}

async function renderEditActivityForm(activity, onSaved) {
  const feedback = el("div");
  const amountInput = el("input", { type: "number", step: "0.01", min: "0", value: activity.amount_spent != null ? activity.amount_spent : "" });
  const categoryInput = el("input", { type: "text", list: "category-options-detail", value: activity.category || "" });
  const dateInput = el("input", { type: "date", value: activity.activity_date });
  const submitBtn = el("button", { class: "primary", text: "Save" });
  const scheduling = await buildSchedulingSection(activity);

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      await api(`/activities/${activity.id}`, {
        method: "PUT",
        body: JSON.stringify({
          activity_date: dateInput.value || null,
          amount_spent: amountInput.value ? parseFloat(amountInput.value) : null,
          category: categoryInput.value || null,
          ...scheduling.getValues(),
        }),
      });
      _categoryOptionsCache = null;
      if (onSaved) onSaved();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Amount" }), amountInput]),
    el("div", { class: "field" }, [el("label", { text: "Category" }), categoryInput]),
    el("div", { class: "field" }, [el("label", { text: "Date" }), dateInput]),
  ]));
  form.appendChild(scheduling.root);
  form.appendChild(submitBtn);

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function renderActivityRow(a, canEdit, onSaved) {
  const wrap = el("div");
  const statusSuffix = a.status && a.status !== "completed" ? ` \u2014 ${a.status}${a.scheduled_at ? " for " + new Date(a.scheduled_at).toLocaleString() : ""}` : "";
  const row = el("div", { class: "ledger-row" }, [
    el("span", { class: "date", text: a.activity_date }),
    el("span", { class: "category", text: (a.category || "\u2014") + statusSuffix }),
    el("span", { class: "amount", text: a.amount_spent != null ? money(a.amount_spent) : "\u2014" }),
  ]);

  const summaryBits = [];
  if (a.notes) summaryBits.push(el("div", { class: "lead", text: a.notes }));
  if (a.assigned_to && a.assigned_to.length > 0) {
    summaryBits.push(el("div", { class: "lead", text: `Assigned: ${a.assigned_to.map((u) => u.email).join(", ")}` }));
  }
  if (a.notification_offsets_minutes && a.notification_offsets_minutes.length > 0) {
    summaryBits.push(el("div", { class: "lead", text: `Notify: ${a.notification_offsets_minutes.map(offsetLabel).join(", ")}` }));
  }

  if (canEdit) {
    const editToggle = el("button", { class: "link-btn", text: "Edit" });
    const editWrap = el("div", { class: "hidden" });
    editToggle.addEventListener("click", async () => {
      const wasHidden = editWrap.classList.contains("hidden");
      editWrap.classList.toggle("hidden");
      if (wasHidden && editWrap.children.length === 0) {
        editWrap.appendChild(await renderEditActivityForm(a, onSaved));
      }
    });
    row.appendChild(editToggle);
    wrap.appendChild(row);
    for (const bit of summaryBits) wrap.appendChild(bit);
    wrap.appendChild(editWrap);
  } else {
    wrap.appendChild(row);
    for (const bit of summaryBits) wrap.appendChild(bit);
  }
  return wrap;
}


async function renderPersonDetail(identityId, onBack, page = 1) {
  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to people" });
  backLink.addEventListener("click", onBack);
  main.appendChild(backLink);

  const container = el("div");
  main.appendChild(container);

  let data;
  try {
    data = await api(`/people/${identityId}/activities?page=${page}&page_size=15`);
  } catch (err) {
    container.appendChild(msg(err.message, "error"));
    return;
  }

  const isHidden = data.name === null;
  const label = isHidden ? "Hidden" : data.name;
  const field = (value) => (isHidden ? "Hidden" : (value || "\u2014"));

  container.appendChild(el("h1", { text: label }));

  if (isHidden && currentUser.role !== "volunteer") {
    container.appendChild(msg("You're not currently authorized to view this person's identifying details. Request elevation to see their name and address.", "info"));
  }

  const card = el("dl", { class: "identity-card" }, [
    el("dt", { text: "Date of birth" }), el("dd", { text: field(data.dob) }),
    el("dt", { text: "Contact" }), el("dd", { text: field(data.contact_info) }),
    el("dt", { text: "Notes" }), el("dd", { text: field(data.notes) }),
    el("dt", { text: "Current address" }), el("dd", { text: field(data.current_address ? data.current_address.address : null) }),
  ]);
  container.appendChild(card);

  if (!isHidden && currentUser.role === "teammember") {
    const editToggle = el("button", { class: "link-btn", text: "Edit" });
    const editWrap = el("div", { class: "hidden" });
    editToggle.addEventListener("click", () => editWrap.classList.toggle("hidden"));
    editWrap.appendChild(renderEditIdentityForm(identityId, data, () => renderPersonDetail(identityId, onBack, page)));
    container.appendChild(editToggle);
    container.appendChild(editWrap);
  }

  if (!isHidden) {
    if (data.address_history.length > 1) {
      const histSection = el("section");
      histSection.appendChild(el("h2", { text: "Address history" }));
      const list = el("ul", { class: "address-history" });
      for (const a of [...data.address_history].reverse()) {
        list.appendChild(el("li", {}, [
          el("span", { class: "move-date", text: a.effective_date + " \u2014 " }),
          a.address,
        ]));
      }
      histSection.appendChild(list);
      container.appendChild(histSection);
    }

    if (currentUser.role === "teammember") {
      const moveSection = el("section");
      moveSection.appendChild(el("h2", { text: "Record a move" }));
      moveSection.appendChild(renderRecordMoveForm(identityId, () => renderPersonDetail(identityId, onBack)));
      container.appendChild(moveSection);
    }

    const hhSection = el("section");
    hhSection.appendChild(el("h2", { text: "Household" }));
    const stripHH = el("div", { class: "totals-strip" }, [
      el("div", { class: "stat" }, [el("span", { class: "label", text: "Adults" }), el("span", { class: "value", text: String(data.total_adults) })]),
      el("div", { class: "stat" }, [el("span", { class: "label", text: "Children" }), el("span", { class: "value", text: String(data.total_children) })]),
      el("div", { class: "stat" }, [el("span", { class: "label", text: "Total in household" }), el("span", { class: "value", text: String(data.total_household) })]),
    ]);
    hhSection.appendChild(stripHH);

    if (data.household_members.length === 0) {
      hhSection.appendChild(el("div", { class: "empty-state", text: "No other household members listed." }));
    } else {
      const hhList = el("div", { class: "ledger" });
      const hhFeedback = el("div");
      for (const m of data.household_members) {
        const row = el("div", { class: "ledger-row" }, [
          el("span", { class: "date", text: m.member_type === "adult" ? "Adult" : "Child" }),
          el("span", { class: "category", text: m.name + (m.relationship ? ` (${m.relationship})` : "") }),
          el("span", { class: "amount", text: m.age != null ? `Age ${m.age}` : "\u2014" }),
        ]);
        if (currentUser.role === "teammember") {
          const removeBtn = el("button", { class: "link-btn", text: "Remove" });
          removeBtn.addEventListener("click", async () => {
            hhFeedback.innerHTML = "";
            try {
              await api(`/identities/${identityId}/household/${m.id}`, { method: "DELETE" });
              renderPersonDetail(identityId, onBack, page);
            } catch (err) { hhFeedback.appendChild(msg(err.message, "error")); }
          });
          row.appendChild(removeBtn);
        }
        hhList.appendChild(row);
      }
      hhSection.appendChild(hhList);
      hhSection.appendChild(hhFeedback);
    }

    if (currentUser.role === "teammember") {
      hhSection.appendChild(renderAddHouseholdMemberForm(identityId, () => renderPersonDetail(identityId, onBack, page)));
    }

    container.appendChild(hhSection);
  }

  const activitySection = el("section");
  activitySection.appendChild(el("h2", { text: "Activity" }));
  const list = el("div", { class: "ledger" });
  if (data.activities.length === 0) {
    list.appendChild(el("div", { class: "empty-state", text: "No activity logged yet." }));
  } else {
    for (const a of data.activities) {
      list.appendChild(renderActivityRow(a, currentUser.role === "teammember", () => renderPersonDetail(identityId, onBack, page)));
    }
  }
  activitySection.appendChild(list);

  const totalPages = Math.max(1, Math.ceil(data.pagination.total / data.pagination.page_size));
  if (totalPages > 1) {
    const pager = el("div", { class: "field-row" });
    const prevBtn = el("button", { class: "secondary", text: "\u2190 Previous" });
    const nextBtn = el("button", { class: "secondary", text: "Next \u2192" });
    if (page <= 1) prevBtn.setAttribute("disabled", "true");
    if (page >= totalPages) nextBtn.setAttribute("disabled", "true");
    prevBtn.addEventListener("click", () => renderPersonDetail(identityId, onBack, page - 1));
    nextBtn.addEventListener("click", () => renderPersonDetail(identityId, onBack, page + 1));
    pager.appendChild(prevBtn);
    pager.appendChild(el("span", { text: `Page ${page} of ${totalPages}` }));
    pager.appendChild(nextBtn);
    activitySection.appendChild(pager);
  }

  container.appendChild(activitySection);

  if (currentUser.role === "teammember") {
    const addSection = el("section");
    addSection.appendChild(el("h2", { text: "Add activity" }));
    addSection.appendChild(await renderAddActivityForm(identityId, () => renderPersonDetail(identityId, onBack)));
    container.appendChild(addSection);
  }

  if (currentUser.role === "admin" || currentUser.role === "teammember") {
    container.appendChild(renderAccessHistorySection(identityId));
  }
}

// ---------- TEAMMEMBER: new person ----------

async function renderNewPersonPage(onCreated, onBack) {
  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to people" });
  backLink.addEventListener("click", onBack);
  main.appendChild(backLink);

  main.appendChild(el("h1", { text: "New person" }));

  const feedback = el("div");
  const submitBtn = el("button", { class: "primary", text: "Add person" });

  // Identity
  const identitySection = el("section");
  identitySection.appendChild(el("h2", { text: "Identity" }));
  const nameInput = el("input", { type: "text", required: "true", placeholder: "Full name" });
  const dobInput = el("input", { type: "date" });
  const contactInput = el("input", { type: "text", placeholder: "Phone" });
  const notesInput = el("textarea", { placeholder: "Notes (optional)" });
  identitySection.appendChild(el("div", { class: "field" }, [el("label", { text: "Full name" }), nameInput]));
  identitySection.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Date of birth" }), dobInput]),
    el("div", { class: "field" }, [el("label", { text: "Phone" }), contactInput]),
  ]));
  identitySection.appendChild(el("div", { class: "field" }, [el("label", { text: "Notes" }), notesInput]));

  // Address
  const addressSection = el("section");
  addressSection.appendChild(el("h2", { text: "Address" }));
  const addressInput = el("input", { type: "text", placeholder: "Current address" });
  addressSection.appendChild(el("div", { class: "field" }, [el("label", { text: "Current address" }), addressInput]));

  // Activity (optional — only logged if amount or category is filled in)
  const activitySection = el("section");
  activitySection.appendChild(el("h2", { text: "Activity" }));
  activitySection.appendChild(el("p", { class: "lead", text: "Optional \u2014 log what was provided today, or skip and add it later from their page." }));
  const amountInput = el("input", { type: "number", step: "0.01", min: "0", placeholder: "0.00" });
  const categoryInput = el("input", { type: "text", list: "category-options-new", placeholder: "e.g. groceries, utilities, rent" });
  const activityDateInput = el("input", { type: "date" });
  activitySection.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Amount" }), amountInput]),
    el("div", { class: "field" }, [el("label", { text: "Category" }), categoryInput]),
    el("div", { class: "field" }, [el("label", { text: "Date" }), activityDateInput]),
  ]));
  categoryDatalist("category-options-new").then((dl) => activitySection.appendChild(dl));
  const scheduling = await buildSchedulingSection();
  activitySection.appendChild(scheduling.root);

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      const identity = await api("/identities", {
        method: "POST",
        body: JSON.stringify({
          full_name: nameInput.value,
          dob: dobInput.value || null,
          contact_info: contactInput.value || null,
          address: addressInput.value || null,
          notes: notesInput.value || null,
        }),
      });
      const schedulingValues = scheduling.getValues();
      if (amountInput.value || categoryInput.value || schedulingValues.notes || schedulingValues.status !== "completed") {
        await api("/activities", {
          method: "POST",
          body: JSON.stringify({
            identity_id: identity.id,
            amount_spent: amountInput.value ? parseFloat(amountInput.value) : null,
            category: categoryInput.value || null,
            activity_date: activityDateInput.value || null,
            ...schedulingValues,
          }),
        });
        _categoryOptionsCache = null;
      }
      if (onCreated) onCreated(identity.id);
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(identitySection);
  form.appendChild(addressSection);
  form.appendChild(activitySection);
  form.appendChild(submitBtn);
  form.appendChild(feedback);
  main.appendChild(form);
}

// ---------- ADMIN: elevation ----------

async function renderElevationSection() {
  const toggle = el("button", { class: "secondary", text: "Elevation request" });
  const body = el("div", { class: "hidden" });
  const statusBox = el("div", { class: "msg info", text: "Checking\u2026" });
  const feedback = el("div");

  const reasonInput = el("input", { type: "text", placeholder: "Reason for access", required: "true" });
  const requestForm = el("form", { class: "hidden" });
  const requestSubmitBtn = el("button", { class: "primary", text: "Request 15-minute access" });
  requestForm.appendChild(el("div", { class: "field-row" }, [el("div", { class: "field" }, [reasonInput])]));
  requestForm.appendChild(requestSubmitBtn);

  let elevated = false;

  async function refreshStatus() {
    const status = await api("/elevation/status");
    elevated = status.elevated;
    if (elevated) {
      statusBox.className = "msg success";
      statusBox.textContent = `Elevated until ${new Date(status.expires_at).toLocaleTimeString()} \u2014 ${status.reason}`;
      toggle.textContent = "End PII access";
      requestForm.classList.add("hidden");
    } else {
      statusBox.className = "msg info";
      statusBox.textContent = "Not currently elevated.";
      toggle.textContent = "Elevation request";
    }
  }

  toggle.addEventListener("click", async () => {
    feedback.innerHTML = "";
    if (elevated) {
      // Elevated → clicking immediately ends it, no form needed.
      try {
        await api("/elevation/revoke", { method: "POST" });
        await refreshStatus();
        body.classList.add("hidden");
      } catch (err) { feedback.appendChild(msg(err.message, "error")); }
    } else {
      // Not elevated → reveal the reason form (or hide it if already open).
      body.classList.toggle("hidden");
      requestForm.classList.toggle("hidden");
    }
  });

  requestForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    feedback.innerHTML = "";
    requestSubmitBtn.setAttribute("disabled", "true");
    try {
      await api("/elevation/request", {
        method: "POST",
        body: JSON.stringify({ reason: reasonInput.value, duration_minutes: 15 }),
      });
      await refreshStatus();
      reasonInput.value = "";
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
    } finally {
      requestSubmitBtn.removeAttribute("disabled");
    }
  });

  body.appendChild(el("h2", { text: "PII access" }));
  body.appendChild(statusBox);
  body.appendChild(requestForm);
  body.appendChild(feedback);

  await refreshStatus();
  return { toggle, body };
}

// ---------- ADMIN: invite user ----------

// ---------- ADMIN: manage team ----------

function renderManageEditForm(u, onSaved) {
  const feedback = el("div");
  const roleSelect = el("select", {}, [
    el("option", { value: "volunteer", text: "Volunteer" }),
    el("option", { value: "teammember", text: "Team member" }),
    el("option", { value: "admin", text: "Admin" }),
  ]);
  roleSelect.value = u.role;
  const startInput = el("input", { type: "date", value: u.term_start_date || "" });
  const endInput = el("input", { type: "date", value: u.term_end_date || "" });
  const termFields = el("div", { class: `field-row ${u.role === "teammember" ? "" : "hidden"}` }, [
    el("div", { class: "field" }, [el("label", { text: "Term start" }), startInput]),
    el("div", { class: "field" }, [el("label", { text: "Term end" }), endInput]),
  ]);
  roleSelect.addEventListener("change", () => {
    termFields.classList.toggle("hidden", roleSelect.value !== "teammember");
  });

  const saveBtn = el("button", { class: "primary", text: "Save" });
  const removeBtn = el("button", { class: "secondary", text: u.is_active ? "Remove access" : "Restore access" });

  async function submitUpdate(isActive) {
    feedback.innerHTML = "";
    try {
      const payload = { role: roleSelect.value, is_active: isActive };
      if (roleSelect.value === "teammember") {
        payload.term_start_date = startInput.value;
        payload.term_end_date = endInput.value;
      }
      await api(`/users/${u.id}`, { method: "PUT", body: JSON.stringify(payload) });
      if (onSaved) onSaved();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
    }
  }

  saveBtn.addEventListener("click", (e) => { e.preventDefault(); submitUpdate(u.is_active); });
  removeBtn.addEventListener("click", (e) => { e.preventDefault(); submitUpdate(!u.is_active); });

  const wrap = el("div");
  wrap.appendChild(el("div", { class: "field" }, [el("label", { text: "Role" }), roleSelect]));
  wrap.appendChild(termFields);
  wrap.appendChild(el("div", { class: "field-row" }, [saveBtn, removeBtn]));
  wrap.appendChild(feedback);
  return wrap;
}

async function renderManageTeamSection() {
  const toggle = el("button", { class: "secondary", text: "Manage team" });
  const body = el("div", { class: "hidden" });
  let built = false;

  toggle.addEventListener("click", async () => {
    body.classList.toggle("hidden");
    if (built) return;
    built = true;

    body.appendChild(el("h2", { text: "Manage team" }));
    const list = el("div", { class: "ledger" });
    body.appendChild(list);

    async function refreshList() {
      list.innerHTML = "";
      let roster;
      try { roster = await api("/users"); }
      catch (e) { list.appendChild(msg(e.message, "error")); return; }

      const others = roster.filter((u) => u.id !== currentUser.id);
      if (others.length === 0) {
        list.appendChild(el("div", { class: "empty-state", text: "No other accounts yet." }));
        return;
      }
      for (const u of others) {
        const rowWrap = el("div");
        const statusText = u.is_active ? u.role : `${u.role} \u2014 inactive`;
        const row = el("div", { class: "ledger-row" }, [
          el("span", { class: "category", text: u.email || u.phone_number || u.username || "\u2014" }),
          el("span", { class: "amount", text: statusText }),
        ]);
        const editToggle = el("button", { class: "link-btn", text: "Edit" });
        const editWrap = el("div", { class: "hidden" });
        editToggle.addEventListener("click", () => {
          editWrap.classList.toggle("hidden");
          if (editWrap.children.length === 0) {
            editWrap.appendChild(renderManageEditForm(u, refreshList));
          }
        });
        row.appendChild(editToggle);
        rowWrap.appendChild(row);
        rowWrap.appendChild(editWrap);
        list.appendChild(rowWrap);
      }
    }

    await refreshList();
  });

  return { toggle, body };
}

// ---------- ADMIN / TEAMMEMBER: invite user ----------

function renderInviteSection(canGrantAdmin) {
  const toggle = el("button", { class: "secondary", text: "Invite team member" });
  const body = el("div", { class: "hidden" });

  toggle.addEventListener("click", () => body.classList.toggle("hidden"));

  body.appendChild(el("h2", { text: "Add someone to the team" }));

  const emailInput = el("input", { type: "email", placeholder: "email@example.com" });
  const phoneInput = el("input", { type: "tel", placeholder: "Cell number" });
  const roleOptions = [
    el("option", { value: "volunteer", text: "Volunteer" }),
    el("option", { value: "teammember", text: "Team member" }),
  ];
  if (canGrantAdmin) roleOptions.push(el("option", { value: "admin", text: "Admin" }));
  const roleSelect = el("select", {}, roleOptions);
  const startInput = el("input", { type: "date" });
  const endInput = el("input", { type: "date" });
  const submitBtn = el("button", { class: "primary", text: "Send invitation" });
  const feedback = el("div");

  const termFields = el("div", { class: "field-row hidden" }, [
    el("div", { class: "field" }, [el("label", { text: "Term start" }), startInput]),
    el("div", { class: "field" }, [el("label", { text: "Term end" }), endInput]),
  ]);
  roleSelect.addEventListener("change", () => {
    termFields.classList.toggle("hidden", roleSelect.value !== "teammember");
  });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    feedback.innerHTML = "";
    if (!emailInput.value && !phoneInput.value) {
      feedback.appendChild(msg("Enter an email or a cell number.", "error"));
      return;
    }
    submitBtn.setAttribute("disabled", "true");
    try {
      const payload = {
        email: emailInput.value || null,
        phone_number: phoneInput.value || null,
        role: roleSelect.value,
      };
      if (roleSelect.value === "teammember") {
        payload.term_start_date = startInput.value;
        payload.term_end_date = endInput.value;
      }
      const result = await api("/users/invite", { method: "POST", body: JSON.stringify(payload) });
      feedback.appendChild(msg(
        result.warning ? result.warning : (result.invitation_sent ? "Invitation sent." : "Added \u2014 invitation will be sent automatically on their start date."),
        result.warning ? "error" : "success",
      ));
      form.reset();
      termFields.classList.add("hidden");
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
    } finally {
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Email" }), emailInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Cell number" }), phoneInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Role" }), roleSelect]));
  form.appendChild(termFields);
  form.appendChild(submitBtn);

  body.appendChild(form);
  body.appendChild(feedback);
  return { toggle, body };
}

// ---------- Dashboard ----------

// ---------- TEAMMEMBER: my info ----------

async function renderMyInfoSection(onSaved) {
  const toggle = el("button", { class: "secondary", text: "My info" });
  const body = el("div", { class: "hidden" });

  let built = false;
  toggle.addEventListener("click", async () => {
    body.classList.toggle("hidden");
    if (built) return;
    built = true;

    let info;
    try { info = await api("/users/me"); }
    catch (e) { body.appendChild(msg(e.message, "error")); return; }

    body.appendChild(el("h2", { text: "My info" }));
    const feedback = el("div");
    const nameInput = el("input", { type: "text", placeholder: "Full name", value: info.full_name || "" });
    const usernameInput = el("input", { type: "text", value: info.username || "" });
    const emailInput = el("input", { type: "email", required: "true", value: info.email });
    const phoneInput = el("input", { type: "tel", placeholder: "Mobile number", value: info.phone_number || "" });
    const emailCb = el("input", { type: "checkbox" });
    if (info.notify_email) emailCb.checked = true;
    const smsCb = el("input", { type: "checkbox" });
    if (info.notify_sms) smsCb.checked = true;
    if (!info.sms_available) smsCb.setAttribute("disabled", "true");

    const submitBtn = el("button", { class: "primary", text: "Save" });
    const form = el("form", { onsubmit: async (e) => {
      e.preventDefault();
      submitBtn.setAttribute("disabled", "true");
      feedback.innerHTML = "";
      try {
        await api("/users/me", {
          method: "PUT",
          body: JSON.stringify({
            full_name: nameInput.value || null,
            username: usernameInput.value || null,
            email: emailInput.value,
            phone_number: phoneInput.value || null,
            notify_email: emailCb.checked,
            notify_sms: smsCb.checked,
          }),
        });
        feedback.appendChild(msg("Saved.", "success"));
        if (onSaved) onSaved();
      } catch (err) {
        feedback.appendChild(msg(err.message, "error"));
      } finally {
        submitBtn.removeAttribute("disabled");
      }
    }});

    form.appendChild(el("div", { class: "field" }, [el("label", { text: "Full name" }), nameInput]));
    form.appendChild(el("div", { class: "field" }, [el("label", { text: "Username" }), usernameInput]));
    form.appendChild(el("div", { class: "field" }, [el("label", { text: "Email" }), emailInput]));
    form.appendChild(el("div", { class: "field" }, [el("label", { text: "Mobile number" }), phoneInput]));
    form.appendChild(el("div", { class: "field" }, [el("label", {}, [emailCb, " Email me"])]));
    const smsLabel = info.sms_available ? " Text me" : " Text me (SMS not configured for this ministry yet)";
    form.appendChild(el("div", { class: "field" }, [el("label", {}, [smsCb, smsLabel])]));
    form.appendChild(submitBtn);

    body.appendChild(form);
    body.appendChild(feedback);

    // Password change — separate section/endpoint from the profile form above.
    body.appendChild(el("h2", { text: "Change password" }));
    const pwFeedback = el("div");
    const newPwInput = el("input", { type: "password", required: "true", placeholder: "New password (10+ characters, mix of types)" });
    const confirmPwInput = el("input", { type: "password", required: "true", placeholder: "Confirm new password" });
    const pwSubmitBtn = el("button", { class: "primary", text: "Update password" });
    const pwForm = el("form", { onsubmit: async (e) => {
      e.preventDefault();
      pwFeedback.innerHTML = "";
      if (newPwInput.value !== confirmPwInput.value) {
        pwFeedback.appendChild(msg("Passwords don't match.", "error"));
        return;
      }
      pwSubmitBtn.setAttribute("disabled", "true");
      try {
        await api("/users/me/password", { method: "PUT", body: JSON.stringify({ new_password: newPwInput.value }) });
        pwFeedback.appendChild(msg("Password updated.", "success"));
        pwForm.reset();
      } catch (err) {
        pwFeedback.appendChild(msg(err.message, "error"));
      } finally {
        pwSubmitBtn.removeAttribute("disabled");
      }
    }});
    pwForm.appendChild(el("div", { class: "field" }, [el("label", { text: "New password" }), newPwInput]));
    pwForm.appendChild(el("div", { class: "field" }, [el("label", { text: "Confirm new password" }), confirmPwInput]));
    pwForm.appendChild(pwSubmitBtn);
    body.appendChild(pwForm);
    body.appendChild(pwFeedback);
  });

  return { toggle, body };
}

async function renderDashboard(user, org) {
  currentUser = user;
  currentOrg = org;
  setHeader(user, org);
  main.innerHTML = "";

  const showList = () => renderDashboard(currentUser, currentOrg);
  const showDetail = (identityId) => renderPersonDetail(identityId, showList);

  const myInfoFor = (label) => renderMyInfoSection(async () => {
    const updated = await api("/auth/me");
    setHeader(updated, currentOrg);
  });

  if (user.role === "admin") {
    const elevation = await renderElevationSection();
    const invite = renderInviteSection(true);
    const manageTeam = await renderManageTeamSection();
    const myInfo = await myInfoFor();

    const section = el("section");
    section.appendChild(el("div", { class: "button-row" }, [elevation.toggle, invite.toggle, manageTeam.toggle, myInfo.toggle]));
    section.appendChild(elevation.body);
    section.appendChild(invite.body);
    section.appendChild(manageTeam.body);
    section.appendChild(myInfo.body);
    main.appendChild(section);
  }
  if (user.role === "teammember") {
    const newPersonBtn = el("button", { class: "secondary", text: "+ New person" });
    newPersonBtn.addEventListener("click", () => renderNewPersonPage((newIdentityId) => showDetail(newIdentityId), showList));
    const invite = renderInviteSection(false);
    const myInfo = await myInfoFor();

    const section = el("section");
    section.appendChild(el("div", { class: "button-row" }, [newPersonBtn, invite.toggle, myInfo.toggle]));
    section.appendChild(invite.body);
    section.appendChild(myInfo.body);
    main.appendChild(section);
  }
  if (user.role === "volunteer") {
    const myInfo = await myInfoFor();
    const section = el("section");
    section.appendChild(el("div", { class: "button-row" }, [myInfo.toggle]));
    section.appendChild(myInfo.body);
    main.appendChild(section);
  }
  main.appendChild(await renderPeopleSection(showDetail));
}

// ---------- First-time account setup ----------

function renderAccountSetup(user, org, onComplete) {
  header.classList.add("hidden");
  main.innerHTML = "";
  const shell = el("div", { class: "signin-shell" });
  shell.appendChild(el("h1", { text: "Complete your account" }));
  shell.appendChild(el("p", { class: "lead", text: "Before you continue, set up your sign-in details." }));

  const feedback = el("div");
  const nameInput = el("input", { type: "text", required: "true", placeholder: "Full name" });
  const emailInput = el("input", { type: "email", required: "true", value: user.email });
  const phoneInput = el("input", { type: "tel", placeholder: "Cell phone" });
  const passwordInput = el("input", { type: "password", required: "true", placeholder: "Password (10+ characters, mix of types)" });
  const confirmInput = el("input", { type: "password", required: "true", placeholder: "Confirm password" });
  const emailCb = el("input", { type: "checkbox" });
  emailCb.checked = true;
  const smsCb = el("input", { type: "checkbox" });
  const usernameField = el("div", { class: "hidden field" });
  const usernameInput = el("input", { type: "text", placeholder: "Choose a login ID" });
  usernameField.appendChild(el("label", { text: "That email is already used to sign in by another account — choose a different login ID" }));
  usernameField.appendChild(usernameInput);

  const submitBtn = el("button", { class: "primary", text: "Complete setup" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    feedback.innerHTML = "";
    if (passwordInput.value !== confirmInput.value) {
      feedback.appendChild(msg("Passwords don't match.", "error"));
      return;
    }
    submitBtn.setAttribute("disabled", "true");
    try {
      const payload = {
        full_name: nameInput.value,
        email: emailInput.value,
        phone_number: phoneInput.value || null,
        password: passwordInput.value,
        notify_email: emailCb.checked,
        notify_sms: smsCb.checked,
      };
      if (usernameInput.value) payload.username = usernameInput.value;
      await api("/users/me/setup", { method: "POST", body: JSON.stringify(payload) });
      onComplete();
    } catch (err) {
      if (err.message.toLowerCase().includes("login id")) {
        usernameField.classList.remove("hidden");
      }
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Full name" }), nameInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Email" }), emailInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Cell phone" }), phoneInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Password" }), passwordInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Confirm password" }), confirmInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", {}, [emailCb, " Email me"])]));
  form.appendChild(el("div", { class: "field" }, [el("label", {}, [smsCb, " Text me"])]));
  form.appendChild(usernameField);
  form.appendChild(submitBtn);

  shell.appendChild(form);
  shell.appendChild(feedback);
  main.appendChild(shell);
}

// ---------- Boot ----------

async function boot() {
  const org = await loadOrgSettings();
  try {
    const user = await api("/auth/me");
    if (user.needs_setup) {
      renderAccountSetup(user, org, () => boot());
    } else {
      await renderDashboard(user, org);
    }
  } catch (e) {
    renderSignIn(org);
  }
}

if (window.location.pathname === "/verify") {
  renderVerify();
} else {
  boot();
}
