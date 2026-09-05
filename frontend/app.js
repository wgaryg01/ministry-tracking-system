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
function buildNotesField(existing = {}) {
  const notesInput = el("textarea", { placeholder: "What was done, or what needs to be done" });
  notesInput.value = existing.notes || "";
  const root = el("div", { class: "field" }, [el("label", { text: "Notes" }), notesInput]);
  return { root, getValue: () => notesInput.value || null };
}

async function buildStatusSchedulingSection(existing = {}) {
  const root = el("div");

  const hasNotifications = existing.status === "scheduled";
  const toggleBtn = el("button", { class: "secondary", type: "button", text: hasNotifications ? "No Notifications" : "Add Notifications" });
  root.appendChild(toggleBtn);

  const scheduledWrap = el("div", { class: hasNotifications ? "" : "hidden" });
  let notificationsOn = hasNotifications;

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

  toggleBtn.addEventListener("click", () => {
    notificationsOn = !notificationsOn;
    toggleBtn.textContent = notificationsOn ? "No Notifications" : "Add Notifications";
    scheduledWrap.classList.toggle("hidden", !notificationsOn);
  });

  return {
    root,
    getValues: () => ({
      status: notificationsOn ? "scheduled" : "completed",
      scheduled_at: notificationsOn && scheduledAtInput.value ? scheduledAtInput.value : null,
      assigned_user_ids: checkboxes.filter((cb) => cb.checked).map((cb) => cb.value),
      notification_offsets_minutes: notificationsOn ? offsetMinutes : [],
    }),
  };
}

function showFilePopup(url, filename, contentType) {
  const overlay = el("div", { class: "file-popup-overlay" });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const closeBtn = el("button", { class: "secondary", text: "Close" });
  closeBtn.addEventListener("click", () => overlay.remove());

  const panel = el("div", { class: "file-popup-panel" });
  panel.appendChild(el("div", { class: "file-popup-header" }, [el("span", { text: filename }), closeBtn]));

  const contentEl = (contentType || "").startsWith("image/")
    ? el("img", { src: url, class: "file-popup-image", alt: filename })
    : el("iframe", { src: url, class: "file-popup-iframe" });
  panel.appendChild(contentEl);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function buildAttachmentUploadField(label = "Attach an invoice or receipt (optional)") {
  const fileInput = el("input", { type: "file", accept: "image/*,application/pdf" });
  const root = el("div", { class: "field" }, [el("label", { text: label }), fileInput]);
  return { root, getFile: () => fileInput.files[0] || null };
}

async function uploadActivityAttachment(activityId, file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`/activities/${activityId}/attachments`, { method: "POST", body: formData, credentials: "same-origin" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.detail || "Attachment upload failed");
  return body;
}


const main = document.getElementById("app-main");
const header = document.getElementById("app-header");
let currentUser = null;
let currentOrg = null;

function roleLabel(role) {
  return role === "volunteer" ? "deacon" : role;
}

function canEdit() {
  // Admin can do everything a teammember can (add/edit recipients,
  // requests, activities, household, addresses, documents, votes) —
  // the only thing that stays admin-exclusive is managing user
  // accounts (invite/manage), handled separately in the dashboard.
  return currentUser.role === "teammember" || currentUser.role === "admin";
}

function setHeader(user, org) {
  if (!user) { header.classList.add("hidden"); return; }
  header.classList.remove("hidden");
  document.getElementById("user-email").textContent = user.full_name || user.email;
  document.getElementById("user-role").textContent = roleLabel(user.role);
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
  section.appendChild(el("h2", { text: "Recipients assisted" }));

  const controls = el("div", { class: "field-row" });
  const searchInput = el("input", { type: "text", placeholder: "Search by name" });
  const sortSelect = el("select", {}, [
    el("option", { value: "recent", text: "Most recent first" }),
    el("option", { value: "oldest", text: "Oldest first" }),
    el("option", { value: "first_name", text: "Alphabetical (first name)" }),
    el("option", { value: "last_name", text: "Alphabetical (last name, first name)" }),
    el("option", { value: "amount", text: "Total amount spent" }),
  ]);
  const searchBtn = el("button", { class: "primary", text: "Search" });
  controls.appendChild(el("div", { class: "field" }, [searchInput]));
  controls.appendChild(el("div", { class: "field" }, [sortSelect]));
  controls.appendChild(searchBtn);
  section.appendChild(controls);
  section.appendChild(el("p", { class: "lead", text: "Showing nothing by default \u2014 search, or press Search with the box empty to see open/recent requests." }));

  const body = el("div");
  section.appendChild(body);

  async function refresh() {
    body.innerHTML = "";
    try {
      const params = new URLSearchParams({ sort: sortSelect.value });
      if (searchInput.value.trim()) params.set("search", searchInput.value.trim());
      const data = await api(`/people?${params.toString()}`);

      const strip = el("div", { class: "totals-strip" });
      for (const [label, key] of [["This month", "month_total"], ["This quarter", "quarter_total"], ["Fiscal YTD", "year_total"], ["All time", "all_time_total"]]) {
        strip.appendChild(el("div", { class: "stat" }, [
          el("span", { class: "label", text: label }),
          el("span", { class: "value", text: money(data.org_totals[key]) }),
        ]));
      }
      body.appendChild(strip);

      if (data.people.length === 0) {
        body.appendChild(el("div", { class: "empty-state", text: searchInput.value.trim() ? "No matches." : "No one currently has an open or recent request." }));
        return;
      }

      const head = el("div", { class: "people-table-head" }, [
        el("span", { class: "who", text: "Recipient" }),
        el("span", { class: "stat-col", text: "Date" }),
        el("span", { class: "stat-col all-time", text: "Status" }),
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
          el("span", { class: "stat-col", text: p.request_date || "\u2014" }),
          el("span", { class: "stat-col all-time", text: p.request_status ? formatRequestStatus(p.request_status) : "\u2014" }),
        ]);
        table.appendChild(row);
      }
      body.appendChild(table);
    } catch (err) {
      body.appendChild(msg(err.message, "error"));
    }
  }

  searchBtn.addEventListener("click", (e) => { e.preventDefault(); refresh(); });
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); refresh(); } });
  sortSelect.addEventListener("change", refresh);

  return section;
}

// ---------- Person detail view ----------

let _datalistCounter = 0;

async function renderAddActivityForm(requestId, onLogged) {
  const feedback = el("div");
  const datalistId = `category-options-${_datalistCounter++}`;
  const notesField = buildNotesField();
  const amountInput = el("input", { type: "number", step: "0.01", min: "0", placeholder: "0.00" });
  const categoryInput = el("input", { type: "text", list: datalistId, placeholder: "e.g. groceries, utilities, rent" });
  const dateInput = el("input", { type: "date" });
  const attachmentField = buildAttachmentUploadField();
  const submitBtn = el("button", { class: "primary", text: "Save Activity" });
  const scheduling = await buildStatusSchedulingSection();

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    let created;
    try {
      created = await api("/activities", {
        method: "POST",
        body: JSON.stringify({
          assistance_request_id: requestId,
          amount_spent: amountInput.value ? parseFloat(amountInput.value) : null,
          category: categoryInput.value || null,
          activity_date: dateInput.value || null,
          notes: notesField.getValue(),
          ...scheduling.getValues(),
        }),
      });
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
      return;
    }

    // The activity itself is now saved regardless of what happens next —
    // an attachment failure should never look like the whole thing failed.
    let attachmentWarning = null;
    const file = attachmentField.getFile();
    if (file) {
      try {
        await uploadActivityAttachment(created.id, file);
      } catch (err) {
        attachmentWarning = err.message;
      }
    }

    feedback.appendChild(msg(
      attachmentWarning ? `Logged, but the attachment failed to upload: ${attachmentWarning}` : "Logged.",
      attachmentWarning ? "error" : "success",
    ));
    form.reset();
    _categoryOptionsCache = null;
    submitBtn.removeAttribute("disabled");
    if (onLogged) onLogged();
  }});

  form.appendChild(notesField.root);
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Date" }), dateInput]),
    el("div", { class: "field" }, [el("label", { text: "Category" }), categoryInput]),
    el("div", { class: "field" }, [el("label", { text: "Amount" }), amountInput]),
  ]));
  form.appendChild(attachmentField.root);
  form.appendChild(scheduling.root);
  form.appendChild(submitBtn);

  const wrap = el("div");
  categoryDatalist(datalistId).then((dl) => wrap.appendChild(dl));
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

function buildAddressFields(existing = {}) {
  const streetInput = el("input", { type: "text", required: "true", placeholder: "Street address", value: existing.street || "" });
  const unitInput = el("input", { type: "text", placeholder: "Apt / unit (optional)", value: existing.unit || "" });
  const cityInput = el("input", { type: "text", required: "true", placeholder: "City", value: existing.city || "" });
  const stateInput = el("input", { type: "text", required: "true", placeholder: "State", value: existing.state || "" });
  const zipInput = el("input", { type: "text", required: "true", placeholder: "ZIP code", value: existing.zip || "" });

  const root = el("div");
  root.appendChild(el("div", { class: "field" }, [el("label", { text: "Street address" }), streetInput]));
  root.appendChild(el("div", { class: "field" }, [el("label", { text: "Apartment or unit" }), unitInput]));
  root.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "City" }), cityInput]),
    el("div", { class: "field" }, [el("label", { text: "State" }), stateInput]),
    el("div", { class: "field" }, [el("label", { text: "ZIP code" }), zipInput]),
  ]));

  return {
    root,
    getValues: () => ({
      street: streetInput.value,
      unit: unitInput.value || null,
      city: cityInput.value,
      state: stateInput.value,
      zip: zipInput.value,
    }),
  };
}

function renderRecordMoveForm(identityId, onRecorded) {
  const feedback = el("div");
  const address = buildAddressFields();
  const dateInput = el("input", { type: "date" });
  const submitBtn = el("button", { class: "secondary", text: "Update address" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      await api(`/identities/${identityId}/addresses`, {
        method: "POST",
        body: JSON.stringify({ ...address.getValues(), effective_date: dateInput.value || null }),
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

  form.appendChild(address.root);
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Effective date" }), dateInput]));
  form.appendChild(submitBtn);

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function buildChecklistFields(options, existingValues = [], existingOther = "") {
  const checkboxes = options.map(([value, label]) => {
    const cb = el("input", { type: "checkbox", value });
    if (existingValues.includes(value)) cb.checked = true;
    return { value, cb, label: el("label", {}, [cb, ` ${label}`]) };
  });
  const otherInput = el("input", { type: "text", placeholder: "Please specify", value: existingOther });
  const hasOther = options.some(([v]) => v === "other");

  const root = el("div");
  for (const { label } of checkboxes) {
    label.style.display = "block";
    root.appendChild(label);
  }
  if (hasOther) root.appendChild(otherInput);

  return {
    root,
    getValues: () => ({
      values: checkboxes.filter((c) => c.cb.checked).map((c) => c.value),
      other: otherInput.value || null,
    }),
  };
}

function parseChecklist(values) {
  // values is a decoded list like ["full_time", "other:seasonal work"] — split out the "other" text.
  const result = { values: [], other: "" };
  for (const v of values || []) {
    if (v.startsWith("other:")) {
      result.values.push("other");
      result.other = v.slice(6);
    } else {
      result.values.push(v);
    }
  }
  return result;
}

const EMPLOYMENT_OPTIONS = [
  ["full_time", "Full-time"], ["part_time", "Part-time"], ["self_employed", "Self-employed"],
  ["unemployed", "Unemployed"], ["retired", "Retired"], ["unable_to_work", "Unable to work"], ["other", "Other"],
];
const REFERRAL_OPTIONS = [
  ["friend_family", "Friend or family member"], ["church", "Church or faith-based organization"],
  ["school", "School"], ["social_media", "Social media"], ["community_org", "Community organization"], ["other", "Other"],
];

function renderEditIdentityForm(identityId, data, onSaved) {
  const feedback = el("div");
  const firstNameInput = el("input", { type: "text", required: "true", placeholder: "First name", value: data.first_name || "" });
  const lastNameInput = el("input", { type: "text", required: "true", placeholder: "Last name", value: data.last_name || "" });
  const phoneInput = el("input", { type: "tel", required: "true", value: data.phone || "" });
  const emailInput = el("input", { type: "email", value: data.email || "" });
  const notesInput = el("textarea", { text: data.notes || "" });

  const parsedEmployment = parseChecklist(data.employment_status);
  const employment = buildChecklistFields(EMPLOYMENT_OPTIONS, parsedEmployment.values, parsedEmployment.other);
  const employerInput = el("input", { type: "text", placeholder: "Employer name", value: data.employer_name || "" });
  const jobTitleInput = el("input", { type: "text", placeholder: "Job title", value: data.job_title || "" });

  const parsedReferral = parseChecklist(data.referral_source);
  const referral = buildChecklistFields(REFERRAL_OPTIONS, parsedReferral.values, parsedReferral.other);
  const referralNameInput = el("input", { type: "text", placeholder: "Name of person/org that referred them", value: data.referral_name || "" });

  const submitBtn = el("button", { class: "primary", text: "Save changes" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      const emp = employment.getValues();
      const ref = referral.getValues();
      await api(`/identities/${identityId}`, {
        method: "PUT",
        body: JSON.stringify({
          first_name: firstNameInput.value,
          last_name: lastNameInput.value,
          phone: phoneInput.value,
          email: emailInput.value || null,
          notes: notesInput.value || null,
          employment_status: emp.values,
          employment_status_other: emp.other,
          employer_name: employerInput.value || null,
          job_title: jobTitleInput.value || null,
          referral_source: ref.values,
          referral_source_other: ref.other,
          referral_name: referralNameInput.value || null,
        }),
      });
      if (onSaved) onSaved();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("h2", { text: "Applicant Info" }));
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "First name" }), firstNameInput]),
    el("div", { class: "field" }, [el("label", { text: "Last name" }), lastNameInput]),
  ]));
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Phone" }), phoneInput]),
    el("div", { class: "field" }, [el("label", { text: "Email" }), emailInput]),
  ]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Notes" }), notesInput]));

  form.appendChild(el("h2", { text: "Employment Info" }));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Employment status" }), employment.root]));
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Employer" }), employerInput]),
    el("div", { class: "field" }, [el("label", { text: "Job title" }), jobTitleInput]),
  ]));

  form.appendChild(el("h2", { text: "How did you hear about us" }));
  form.appendChild(el("div", { class: "field" }, [referral.root]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Referred by" }), referralNameInput]));

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
  const datalistId = `category-options-${_datalistCounter++}`;
  const notesField = buildNotesField(activity);
  const amountInput = el("input", { type: "number", step: "0.01", min: "0", value: activity.amount_spent != null ? activity.amount_spent : "" });
  const categoryInput = el("input", { type: "text", list: datalistId, value: activity.category || "" });
  const dateInput = el("input", { type: "date", value: activity.activity_date });
  const attachmentField = buildAttachmentUploadField();
  const submitBtn = el("button", { class: "primary", text: "Save Activity" });
  const scheduling = await buildStatusSchedulingSection(activity);

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
          notes: notesField.getValue(),
          payment_approved: activity.payment_approved,
          ...scheduling.getValues(),
        }),
      });
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
      return;
    }

    // Saved successfully regardless of what happens with the attachment next.
    let attachmentWarning = null;
    const file = attachmentField.getFile();
    if (file) {
      try {
        await uploadActivityAttachment(activity.id, file);
      } catch (err) {
        attachmentWarning = err.message;
      }
    }

    _categoryOptionsCache = null;
    if (attachmentWarning) {
      feedback.appendChild(msg(`Saved, but the attachment failed to upload: ${attachmentWarning}`, "error"));
      submitBtn.removeAttribute("disabled");
    }
    if (onSaved) onSaved();
  }});

  form.appendChild(notesField.root);
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Date" }), dateInput]),
    el("div", { class: "field" }, [el("label", { text: "Category" }), categoryInput]),
    el("div", { class: "field" }, [el("label", { text: "Amount" }), amountInput]),
  ]));
  form.appendChild(attachmentField.root);
  form.appendChild(scheduling.root);
  form.appendChild(submitBtn);

  const wrap = el("div");
  categoryDatalist(datalistId).then((dl) => wrap.appendChild(dl));
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function renderActivityRow(a, canEdit, onSaved) {
  const wrap = el("div");
  const statusSuffix = a.status && a.status !== "completed" ? ` \u2014 ${a.status}${a.scheduled_at ? " for " + new Date(a.scheduled_at).toLocaleString() : ""}` : "";
  const amountText = a.amount_spent != null
    ? money(a.amount_spent) + (a.payment_approved ? "" : " (quote)")
    : "\u2014";

  const amountCol = el("div", { class: "amount-col" });
  amountCol.appendChild(el("span", { class: "amount", text: amountText }));
  if (canEdit && a.amount_spent != null) {
    const approveCb = el("input", { type: "checkbox" });
    approveCb.checked = a.payment_approved;
    approveCb.addEventListener("change", async () => {
      approveCb.setAttribute("disabled", "true");
      try {
        await api(`/activities/${a.id}/payment-approval`, {
          method: "PUT",
          body: JSON.stringify({ payment_approved: approveCb.checked }),
        });
        if (onSaved) onSaved();
      } catch (err) {
        approveCb.checked = !approveCb.checked;
        approveCb.removeAttribute("disabled");
      }
    });
    amountCol.appendChild(el("label", {}, [approveCb, " Approved to be paid"]));
  }

  const row = el("div", { class: "ledger-row" }, [
    el("span", { class: "date", text: a.activity_date }),
    el("span", { class: "category", text: (a.category || "\u2014") + statusSuffix }),
    amountCol,
  ]);

  const summaryBits = [];
  if (a.notes) summaryBits.push(el("div", { class: "lead", text: a.notes }));
  if (a.attachments && a.attachments.length > 0) {
    const line = el("div", { class: "lead" }, ["Attachments: "]);
    a.attachments.forEach((att, idx) => {
      if (idx > 0) line.appendChild(document.createTextNode(", "));
      const link = el("button", { class: "link-btn", text: att.filename });
      link.addEventListener("click", () => showFilePopup(`/activities/${a.id}/attachments/${att.id}`, att.filename, att.content_type));
      line.appendChild(link);
    });
    summaryBits.push(line);
  } else if (a.attachment_count) {
    summaryBits.push(el("div", { class: "lead", text: `${a.attachment_count} attachment${a.attachment_count !== 1 ? "s" : ""}` }));
  }
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


function formatAddress(a) {
  if (!a) return "\u2014";
  const line1 = a.unit ? `${a.street}, ${a.unit}` : a.street;
  return `${line1}, ${a.city}, ${a.state} ${a.zip}`;
}

function formatChecklist(values) {
  if (!values || values.length === 0) return "\u2014";
  return values.map((v) => (v.startsWith("other:") ? v.slice(6) : v.replace(/_/g, " "))).join(", ");
}

function renderNewRequestForm(identityId, onCreated) {
  const feedback = el("div");
  const typeInput = el("input", { type: "text", required: "true", placeholder: "What kind of assistance is being requested?" });
  const situationInput = el("textarea", { placeholder: "Their situation, in their own words" });
  const receivedDateInput = el("input", { type: "date" });
  const helperNameInput = el("input", { type: "text", placeholder: "Helper's name" });
  const helperContactInput = el("input", { type: "text", placeholder: "Helper's phone or email" });
  const helperRelInput = el("input", { type: "text", placeholder: "Helper's relationship to applicant" });
  const paperFormField = buildAttachmentUploadField("Attach the intake paper form (if available)");
  const submitBtn = el("button", { class: "primary", text: "Create request" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      const created = await api(`/identities/${identityId}/requests`, {
        method: "POST",
        body: JSON.stringify({
          assistance_type: typeInput.value,
          situation_description: situationInput.value || null,
          request_received_date: receivedDateInput.value || null,
          helper_name: helperNameInput.value || null,
          helper_contact: helperContactInput.value || null,
          helper_relationship: helperRelInput.value || null,
        }),
      });
      const paperFile = paperFormField.getFile();
      if (paperFile) {
        const formData = new FormData();
        formData.append("file", paperFile);
        await fetch(`/requests/${created.id}/documents`, { method: "POST", body: formData, credentials: "same-origin" });
      }
      if (onCreated) onCreated();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Assistance requested" }), typeInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Situation" }), situationInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Request received date" }), receivedDateInput]));
  form.appendChild(paperFormField.root);
  form.appendChild(el("p", { class: "lead", text: "If someone helped complete this request:" }));
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Helper name" }), helperNameInput]),
    el("div", { class: "field" }, [el("label", { text: "Helper contact" }), helperContactInput]),
    el("div", { class: "field" }, [el("label", { text: "Relationship" }), helperRelInput]),
  ]));
  form.appendChild(submitBtn);

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function renderDocumentUploadForm(requestId, onUploaded) {
  const feedback = el("div");
  const fileInput = el("input", { type: "file", required: "true", accept: "image/*,application/pdf" });
  const submitBtn = el("button", { class: "secondary", text: "Upload document" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    if (!fileInput.files[0]) return;
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      const formData = new FormData();
      formData.append("file", fileInput.files[0]);
      const res = await fetch(`/requests/${requestId}/documents`, { method: "POST", body: formData, credentials: "same-origin" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || "Upload failed");
      form.reset();
      if (onUploaded) onUploaded();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
    } finally {
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(fileInput);
  form.appendChild(submitBtn);

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

const REQUEST_STATUS_OPTIONS = [
  ["new", "New"], ["approved", "Approved"], ["denied", "Denied"],
  ["in_progress", "In Progress"], ["on_hold", "On Hold"],
  ["completed", "Completed"], ["canceled", "Canceled"],
];

function formatRequestStatus(status) {
  const found = REQUEST_STATUS_OPTIONS.find(([v]) => v === status);
  return found ? found[1] : status;
}

async function renderRequestCard(req, identityId, isHidden, onChanged) {
  const card = el("div", { class: "identity-card" });

  const summaryRow = el("div", { class: "request-row" });
  summaryRow.appendChild(el("span", { class: "req-date", text: req.created_at ? req.created_at.slice(0, 10) : "\u2014" }));

  const expandLink = el("button", { class: "link-btn req-need", text: req.assistance_type || "Hidden" });
  summaryRow.appendChild(expandLink);

  if (canEdit() && !isHidden) {
    const statusSelect = el("select", { class: "req-status" }, REQUEST_STATUS_OPTIONS.map(([v, l]) => el("option", { value: v, text: l })));
    statusSelect.value = req.status;
    const statusFeedback = el("span", { class: "req-status-feedback" });
    statusSelect.addEventListener("change", async (e) => {
      e.stopPropagation();
      statusFeedback.textContent = "Saving\u2026";
      try {
        await api(`/requests/${req.id}`, {
          method: "PUT",
          body: JSON.stringify({
            assistance_type: req.assistance_type,
            situation_description: req.situation_description,
            status: statusSelect.value,
            request_received_date: req.request_received_date,
            helper_name: req.helper_name,
            helper_contact: req.helper_contact,
            helper_relationship: req.helper_relationship,
          }),
        });
        // Update in place — no full-page refresh, so nothing else the
        // user was doing on this page (like a half-filled form) is lost.
        req.status = statusSelect.value;
        statusFeedback.textContent = "Saved.";
        setTimeout(() => { statusFeedback.textContent = ""; }, 1500);
      } catch (err) {
        statusFeedback.textContent = err.message;
      }
    });
    summaryRow.appendChild(statusSelect);
    summaryRow.appendChild(statusFeedback);
  } else {
    summaryRow.appendChild(el("span", { class: "req-status", text: formatRequestStatus(req.status) }));
  }

  summaryRow.appendChild(el("span", { class: "req-amount", text: money(req.total_amount) }));

  const viewActivitiesToggle = el("button", { class: "link-btn", text: "View activities" });
  summaryRow.appendChild(viewActivitiesToggle);

  card.appendChild(summaryRow);

  const body = el("div", { class: "hidden" });
  card.appendChild(body);

  let built = false;
  expandLink.addEventListener("click", async () => {
    body.classList.toggle("hidden");
    if (built) return;
    built = true;

    if (!isHidden) {
      body.appendChild(el("dl", {}, [
        el("dt", { text: "Situation" }), el("dd", { text: req.situation_description || "\u2014" }),
        el("dt", { text: "Request received" }), el("dd", { text: req.request_received_date || "\u2014" }),
        el("dt", { text: "Helper" }), el("dd", { text: req.helper_name ? `${req.helper_name} \u2014 ${req.helper_contact || ""} (${req.helper_relationship || ""})` : "\u2014" }),
      ]));

      const voteSection = el("section");
      voteSection.appendChild(el("h2", { text: "Team vote" }));
      const voteTally = el("p", { class: "lead" });
      const updateTally = () => {
        voteTally.textContent = `${req.votes.yes} yes \u00b7 ${req.votes.no} no`;
      };
      updateTally();
      voteSection.appendChild(voteTally);

      const yesBtn = el("button", { class: req.votes.my_vote === true ? "primary" : "secondary", text: "Yes" });
      const noBtn = el("button", { class: req.votes.my_vote === false ? "primary" : "secondary", text: "No" });
      const voteFeedback = el("div");
      async function castVote(support) {
        voteFeedback.innerHTML = "";
        try {
          await api(`/requests/${req.id}/vote`, { method: "PUT", body: JSON.stringify({ support }) });
          if (req.votes.my_vote === true) req.votes.yes--;
          if (req.votes.my_vote === false) req.votes.no--;
          if (support) req.votes.yes++; else req.votes.no++;
          req.votes.my_vote = support;
          yesBtn.className = support === true ? "primary" : "secondary";
          noBtn.className = support === false ? "primary" : "secondary";
          updateTally();
        } catch (err) {
          voteFeedback.appendChild(msg(err.message, "error"));
        }
      }
      yesBtn.addEventListener("click", () => castVote(true));
      noBtn.addEventListener("click", () => castVote(false));
      voteSection.appendChild(el("div", { class: "field-row" }, [yesBtn, noBtn]));
      voteSection.appendChild(voteFeedback);
      body.appendChild(voteSection);

      const docSection = el("section");
      docSection.appendChild(el("h2", { text: "Documents" }));
      if (req.documents.length === 0) {
        docSection.appendChild(el("div", { class: "empty-state", text: "No documents attached." }));
      } else {
        for (const d of req.documents) {
          const row = el("div", { class: "ledger-row" });
          row.appendChild(el("button", {
            class: "link-btn category",
            text: d.filename,
            onclick: () => showFilePopup(`/requests/${req.id}/documents/${d.id}`, d.filename, d.content_type),
          }));
          if (canEdit()) {
            const delBtn = el("button", { class: "link-btn", text: "Delete" });
            delBtn.addEventListener("click", async () => {
              await api(`/requests/${req.id}/documents/${d.id}`, { method: "DELETE" });
              if (onChanged) onChanged();
            });
            row.appendChild(delBtn);
          }
          docSection.appendChild(row);
        }
      }
      if (canEdit()) {
        docSection.appendChild(renderDocumentUploadForm(req.id, onChanged));
      }
      body.appendChild(docSection);
    }
  });

  const activitiesBody = el("div", { class: "hidden" });
  card.appendChild(activitiesBody);

  let activitiesBuilt = false;
  viewActivitiesToggle.addEventListener("click", async (e) => {
    e.stopPropagation();
    const nowHidden = activitiesBody.classList.toggle("hidden");
    viewActivitiesToggle.textContent = nowHidden ? "View activities" : "Hide activities";
    if (activitiesBuilt) return;
    activitiesBuilt = true;

    const activitySection = el("section");
    activitySection.appendChild(el("h2", { text: "Activity" }));
    const list = el("div", { class: "ledger" });
    if (req.activities.length === 0) {
      list.appendChild(el("div", { class: "empty-state", text: "No activity logged yet." }));
    } else {
      for (const a of req.activities) {
        list.appendChild(renderActivityRow(a, canEdit(), onChanged));
      }
    }
    activitySection.appendChild(list);
    activitiesBody.appendChild(activitySection);

    if (canEdit()) {
      const addSection = el("section");
      addSection.appendChild(el("h2", { text: "Add activity" }));
      addSection.appendChild(await renderAddActivityForm(req.id, onChanged));
      activitiesBody.appendChild(addSection);
    }
  });

  return card;
}

async function renderPersonDetail(identityId, onBack) {
  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to recipients" });
  backLink.addEventListener("click", onBack);
  main.appendChild(backLink);

  const container = el("div");
  main.appendChild(container);

  let data;
  try {
    data = await api(`/people/${identityId}`);
  } catch (err) {
    container.appendChild(msg(err.message, "error"));
    return;
  }

  const isHidden = data.name === null;
  const label = isHidden ? "Hidden" : data.name;
  const field = (value) => (isHidden ? "Hidden" : (value || "\u2014"));
  const refresh = () => renderPersonDetail(identityId, onBack);

  container.appendChild(el("h1", { text: label }));

  if (isHidden && currentUser.role !== "volunteer") {
    container.appendChild(msg("You're not currently authorized to view this person's identifying details. Request elevation to see their full record.", "info"));
  }

  const summaryCard = el("div", { class: "totals-strip" }, [
    el("div", { class: "stat" }, [el("span", { class: "label", text: "Phone" }), el("span", { class: "value value-text", text: field(data.phone) })]),
    el("div", { class: "stat" }, [el("span", { class: "label", text: "Email" }), el("span", { class: "value value-text", text: field(data.email) })]),
  ]);
  container.appendChild(summaryCard);

  const detailsToggle = el("button", { class: "link-btn", text: "Show details" });
  const detailsBody = el("div", { class: "hidden" });
  detailsToggle.addEventListener("click", () => {
    const nowHidden = detailsBody.classList.toggle("hidden");
    detailsToggle.textContent = nowHidden ? "Show details" : "Hide details";
  });
  container.appendChild(detailsToggle);
  container.appendChild(detailsBody);

  const card = el("dl", { class: "identity-card" }, [
    el("dt", { text: "Employment" }), el("dd", { text: isHidden ? "Hidden" : formatChecklist(data.employment_status) }),
    el("dt", { text: "Employer" }), el("dd", { text: field(data.employer_name) }),
    el("dt", { text: "Job title" }), el("dd", { text: field(data.job_title) }),
    el("dt", { text: "How they heard about us" }), el("dd", { text: isHidden ? "Hidden" : formatChecklist(data.referral_source) }),
    el("dt", { text: "Referred by" }), el("dd", { text: field(data.referral_name) }),
    el("dt", { text: "Notes" }), el("dd", { text: field(data.notes) }),
    el("dt", { text: "Current address" }), el("dd", { text: isHidden ? "Hidden" : formatAddress(data.current_address) }),
  ]);
  detailsBody.appendChild(card);

  if (!isHidden && canEdit()) {
    const editToggle = el("button", { class: "link-btn", text: "Edit" });
    const editWrap = el("div", { class: "hidden" });
    editToggle.addEventListener("click", () => editWrap.classList.toggle("hidden"));
    editWrap.appendChild(renderEditIdentityForm(identityId, data, refresh));
    detailsBody.appendChild(editToggle);
    detailsBody.appendChild(editWrap);
  }

  if (!isHidden) {
    if (data.address_history.length > 1) {
      const histSection = el("section");
      histSection.appendChild(el("h2", { text: "Address history" }));
      const list = el("ul", { class: "address-history" });
      for (const a of [...data.address_history].reverse()) {
        list.appendChild(el("li", {}, [
          el("span", { class: "move-date", text: a.effective_date + " \u2014 " }),
          formatAddress(a),
        ]));
      }
      histSection.appendChild(list);
      container.appendChild(histSection);
    }

    if (canEdit()) {
      const moveToggle = el("button", { class: "secondary", text: "Update the address" });
      const moveWrap = el("div", { class: "hidden" });
      moveToggle.addEventListener("click", () => {
        moveWrap.classList.toggle("hidden");
        if (moveWrap.children.length === 0) moveWrap.appendChild(renderRecordMoveForm(identityId, refresh));
      });
      container.appendChild(moveToggle);
      container.appendChild(moveWrap);
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
        if (canEdit()) {
          const removeBtn = el("button", { class: "link-btn", text: "Remove" });
          removeBtn.addEventListener("click", async () => {
            hhFeedback.innerHTML = "";
            try {
              await api(`/identities/${identityId}/household/${m.id}`, { method: "DELETE" });
              refresh();
            } catch (err) { hhFeedback.appendChild(msg(err.message, "error")); }
          });
          row.appendChild(removeBtn);
        }
        hhList.appendChild(row);
      }
      hhSection.appendChild(hhList);
      hhSection.appendChild(hhFeedback);
    }

    if (canEdit()) {
      const addHHToggle = el("button", { class: "secondary", text: "+ Add household member" });
      const addHHWrap = el("div", { class: "hidden" });
      addHHToggle.addEventListener("click", () => {
        addHHWrap.classList.toggle("hidden");
        if (addHHWrap.children.length === 0) {
          addHHWrap.appendChild(renderAddHouseholdMemberForm(identityId, refresh));
        }
      });
      hhSection.appendChild(addHHToggle);
      hhSection.appendChild(addHHWrap);
    }

    container.appendChild(hhSection);
  }

  const reqSection = el("section");
  reqSection.appendChild(el("h2", { text: "Assistance Requests" }));
  if (data.requests.length === 0) {
    reqSection.appendChild(el("div", { class: "empty-state", text: "No requests yet." }));
  } else {
    reqSection.appendChild(el("div", { class: "request-row request-row-head" }, [
      el("span", { class: "req-date", text: "Date" }),
      el("span", { class: "req-need", text: "Need" }),
      el("span", { class: "req-status", text: "Status" }),
      el("span", { class: "req-amount", text: "Total" }),
    ]));
  }
  for (const req of data.requests) {
    reqSection.appendChild(await renderRequestCard(req, identityId, isHidden, refresh));
  }
  if (canEdit()) {
    const newReqToggle = el("button", { class: "secondary", text: "+ New request" });
    const newReqWrap = el("div", { class: "hidden" });
    newReqToggle.addEventListener("click", () => {
      newReqWrap.classList.toggle("hidden");
      if (newReqWrap.children.length === 0) newReqWrap.appendChild(renderNewRequestForm(identityId, refresh));
    });
    reqSection.appendChild(newReqToggle);
    reqSection.appendChild(newReqWrap);
  }
  container.appendChild(reqSection);

  if (currentUser.role === "admin" || currentUser.role === "teammember") {
    container.appendChild(renderAccessHistorySection(identityId));
  }
}

// ---------- TEAMMEMBER: new person ----------

function buildHouseholdIntakeSection() {
  const members = []; // { member_type, name, age, relationship }
  const list = el("div", { class: "ledger" });

  function renderList() {
    list.innerHTML = "";
    if (members.length === 0) {
      list.appendChild(el("div", { class: "empty-state", text: "No other household members added." }));
      return;
    }
    members.forEach((m, idx) => {
      const removeBtn = el("button", { class: "link-btn", type: "button", text: "Remove" });
      removeBtn.addEventListener("click", () => { members.splice(idx, 1); renderList(); });
      list.appendChild(el("div", { class: "ledger-row" }, [
        el("span", { class: "date", text: m.member_type === "adult" ? "Adult" : "Child" }),
        el("span", { class: "category", text: m.name + (m.relationship ? ` (${m.relationship})` : "") }),
        el("span", { class: "amount", text: m.age != null ? `Age ${m.age}` : "\u2014" }),
        removeBtn,
      ]));
    });
  }
  renderList();

  const typeSelect = el("select", {}, [el("option", { value: "adult", text: "Adult" }), el("option", { value: "child", text: "Child" })]);
  const nameInput = el("input", { type: "text", placeholder: "Name" });
  const ageInput = el("input", { type: "number", min: "0", placeholder: "Age" });
  const relInput = el("input", { type: "text", placeholder: "Relationship to applicant" });
  const addBtn = el("button", { class: "secondary", type: "button", text: "+ Add household member" });
  addBtn.addEventListener("click", () => {
    if (!nameInput.value) return;
    members.push({
      member_type: typeSelect.value,
      name: nameInput.value,
      age: ageInput.value ? parseInt(ageInput.value, 10) : null,
      relationship: relInput.value || null,
    });
    nameInput.value = ""; ageInput.value = ""; relInput.value = "";
    renderList();
  });

  const root = el("div");
  root.appendChild(list);
  root.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Type" }), typeSelect]),
    el("div", { class: "field" }, [el("label", { text: "Name" }), nameInput]),
    el("div", { class: "field" }, [el("label", { text: "Age" }), ageInput]),
    el("div", { class: "field" }, [el("label", { text: "Relationship" }), relInput]),
  ]));
  root.appendChild(addBtn);

  return { root, getMembers: () => members };
}

async function renderNewPersonPage(onCreated, onBack) {
  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to recipients" });
  backLink.addEventListener("click", onBack);
  main.appendChild(backLink);

  main.appendChild(el("h1", { text: "New recipient" }));
  main.appendChild(el("p", { class: "lead", text: "Complete as much of this as you can \u2014 it mirrors the assistance request intake form." }));

  const feedback = el("div");
  const submitBtn = el("button", { class: "primary", text: "Save" });

  // Applicant Info
  const applicantSection = el("section");
  applicantSection.appendChild(el("h2", { text: "Applicant Info" }));
  const firstNameInput = el("input", { type: "text", required: "true", placeholder: "First name" });
  const lastNameInput = el("input", { type: "text", required: "true", placeholder: "Last name" });
  const phoneInput = el("input", { type: "tel", required: "true", placeholder: "Phone number" });
  const emailInput = el("input", { type: "email", placeholder: "Email address (optional)" });
  const notesInput = el("textarea", { placeholder: "Notes (optional)" });
  applicantSection.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "First name" }), firstNameInput]),
    el("div", { class: "field" }, [el("label", { text: "Last name" }), lastNameInput]),
  ]));
  applicantSection.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Phone number" }), phoneInput]),
    el("div", { class: "field" }, [el("label", { text: "Email address (optional)" }), emailInput]),
  ]));
  const address = buildAddressFields();
  applicantSection.appendChild(address.root);
  applicantSection.appendChild(el("div", { class: "field" }, [el("label", { text: "Notes" }), notesInput]));

  // Employment Info
  const employmentSection = el("section");
  employmentSection.appendChild(el("h2", { text: "Employment Info" }));
  employmentSection.appendChild(el("p", { class: "lead", text: "Select all that apply." }));
  const employment = buildChecklistFields(EMPLOYMENT_OPTIONS);
  employmentSection.appendChild(employment.root);
  const employerInput = el("input", { type: "text", placeholder: "Employer name (if applicable)" });
  const jobTitleInput = el("input", { type: "text", placeholder: "Job title (if applicable)" });
  employmentSection.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Employer name" }), employerInput]),
    el("div", { class: "field" }, [el("label", { text: "Job title" }), jobTitleInput]),
  ]));

  // Household Info
  const householdSection = el("section");
  householdSection.appendChild(el("h2", { text: "Household Info" }));
  householdSection.appendChild(el("p", { class: "lead", text: "List each additional child or adult living at this address. Totals are calculated automatically." }));
  const household = buildHouseholdIntakeSection();
  householdSection.appendChild(household.root);

  // How did you hear about us
  const referralSection = el("section");
  referralSection.appendChild(el("h2", { text: "How Did You Hear About Us" }));
  const referral = buildChecklistFields(REFERRAL_OPTIONS);
  referralSection.appendChild(referral.root);
  const referralNameInput = el("input", { type: "text", placeholder: "Name of person or organization that referred you (if applicable)" });
  referralSection.appendChild(el("div", { class: "field" }, [el("label", { text: "Referred by" }), referralNameInput]));

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      const emp = employment.getValues();
      const ref = referral.getValues();
      const identity = await api("/identities", {
        method: "POST",
        body: JSON.stringify({
          first_name: firstNameInput.value,
          last_name: lastNameInput.value,
          phone: phoneInput.value,
          email: emailInput.value || null,
          notes: notesInput.value || null,
          address: address.getValues(),
          employment_status: emp.values,
          employment_status_other: emp.other,
          employer_name: employerInput.value || null,
          job_title: jobTitleInput.value || null,
          referral_source: ref.values,
          referral_source_other: ref.other,
          referral_name: referralNameInput.value || null,
        }),
      });
      for (const member of household.getMembers()) {
        await api(`/identities/${identity.id}/household`, { method: "POST", body: JSON.stringify(member) });
      }
      if (onCreated) onCreated(identity.id);
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(applicantSection);
  form.appendChild(employmentSection);
  form.appendChild(householdSection);
  form.appendChild(referralSection);
  form.appendChild(submitBtn);
  form.appendChild(feedback);
  main.appendChild(form);
}

// ---------- ADMIN: elevation ----------

// ---------- TEAMMEMBER: team directory (read-only) ----------

async function renderTeamDirectorySection() {
  const toggle = el("button", { class: "secondary", text: "Team directory" });
  const body = el("div", { class: "hidden" });
  let built = false;

  toggle.addEventListener("click", async () => {
    body.classList.toggle("hidden");
    if (built) return;
    built = true;

    body.appendChild(el("h2", { text: "Team directory" }));
    try {
      const roster = await api("/users?role=teammember");
      if (roster.length === 0) {
        body.appendChild(el("div", { class: "empty-state", text: "No other team members yet." }));
      } else {
        const list = el("div", { class: "ledger" });
        for (const u of roster) {
          list.appendChild(el("div", { class: "ledger-row" }, [
            el("span", { class: "date", text: u.full_name || u.username || "\u2014" }),
            el("span", { class: "category", text: u.email || "\u2014" }),
            el("span", { class: "amount", text: u.phone_number || "\u2014" }),
          ]));
        }
        body.appendChild(list);
      }
    } catch (err) {
      body.appendChild(msg(err.message, "error"));
    }
  });

  return { toggle, body };
}

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
    el("option", { value: "volunteer", text: "Deacon" }),
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
        const statusText = u.is_active ? roleLabel(u.role) : `${roleLabel(u.role)} \u2014 inactive`;
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
    el("option", { value: "volunteer", text: "Deacon" }),
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
    const newPersonBtn = el("button", { class: "secondary", text: "+ New recipient" });
    newPersonBtn.addEventListener("click", () => renderNewPersonPage((newIdentityId) => showDetail(newIdentityId), showList));
    const invite = renderInviteSection(true);
    const manageTeam = await renderManageTeamSection();
    const myInfo = await myInfoFor();

    const section = el("section");
    section.appendChild(el("div", { class: "button-row" }, [newPersonBtn, invite.toggle, manageTeam.toggle, myInfo.toggle]));
    section.appendChild(invite.body);
    section.appendChild(manageTeam.body);
    section.appendChild(myInfo.body);
    main.appendChild(section);
  }
  if (user.role === "teammember") {
    const newPersonBtn = el("button", { class: "secondary", text: "+ New recipient" });
    newPersonBtn.addEventListener("click", () => renderNewPersonPage((newIdentityId) => showDetail(newIdentityId), showList));
    const directory = await renderTeamDirectorySection();
    const myInfo = await myInfoFor();

    const section = el("section");
    section.appendChild(el("div", { class: "button-row" }, [newPersonBtn, directory.toggle, myInfo.toggle]));
    section.appendChild(directory.body);
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
