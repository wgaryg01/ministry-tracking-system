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
let _presencePollInterval = null; // cleared/reset whenever we navigate to a different page

function formatDateDisplay(isoDate) {
  if (!isoDate) return isoDate;
  const datePart = isoDate.slice(0, 10); // strip any time component if present
  const parts = datePart.split("-");
  if (parts.length !== 3) return isoDate;
  const [y, m, d] = parts;
  return `${m}-${d}-${y}`;
}

function formatDateTimeDisplay(isoDateTime) {
  if (!isoDateTime) return isoDateTime;
  // The backend emits naive UTC timestamps (Python's datetime.utcnow().isoformat())
  // with no timezone suffix. Per spec, a date-time string with a time
  // component but no explicit timezone is parsed by JS as LOCAL time,
  // not UTC — so without this, the displayed time is silently wrong
  // (mislabeled UTC clock digits) for anyone not in UTC. Appending "Z"
  // when no timezone marker is present makes the conversion real.
  const hasTimezone = /Z$|[+-]\d{2}:?\d{2}$/.test(isoDateTime);
  const dt = new Date(hasTimezone ? isoDateTime : isoDateTime + "Z");
  if (isNaN(dt)) return isoDateTime;
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  const y = dt.getFullYear();
  const time = dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${m}-${d}-${y} ${time}`;
}

function roleLabel(role) {
  if (role === "volunteer") return "deacon";
  if (role === "financial_secretary") return "financial secretary";
  return role;
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
  document.getElementById("brand-name").textContent = siteDisplayName(org);
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

function siteDisplayName(org) {
  return org.environment === "development" ? `${org.ministry_name} (Development)` : org.ministry_name;
}

async function loadOrgSettings() {
  try { return await api("/org/settings"); }
  catch (e) { return { ministry_name: "Mission Home", has_logo: false, environment: "production" }; }
}

// ---------- Sign-in view ----------

function renderSignIn(org) {
  header.classList.add("hidden");
  main.innerHTML = "";
  const shell = el("div", { class: "signin-shell" });
  if (org.has_logo) shell.appendChild(el("img", { class: "brand-logo-large", src: "/org/logo", alt: "" }));
  shell.appendChild(el("h1", { text: siteDisplayName(org) }));
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
  const searchInput = el("input", { type: "text", placeholder: "Search by name (4+ characters)" });
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
  section.appendChild(el("p", { class: "lead", text: "Enter at least 4 characters of a name to search." }));

  const body = el("div");
  section.appendChild(body);

  const MIN_SEARCH_LENGTH = 4;

  async function refresh() {
    const term = searchInput.value.trim();
    body.innerHTML = "";

    if (term.length < MIN_SEARCH_LENGTH) {
      body.appendChild(el("div", { class: "empty-state", text: `Enter at least ${MIN_SEARCH_LENGTH} characters to search.` }));
      return;
    }

    try {
      const params = new URLSearchParams({ sort: sortSelect.value, search: term });
      const data = await api(`/people?${params.toString()}`);

      if (data.people.length === 0) {
        body.appendChild(el("div", { class: "empty-state", text: "No matches." }));
        return;
      }

      const head = el("div", { class: "people-table-head" }, [
        el("span", { class: "who", text: "Recipient" }),
        el("span", { class: "date-col", text: "Date" }),
        el("span", { class: "status-col", text: "Status" }),
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
          el("span", { class: "date-col", text: p.request_date ? formatDateDisplay(p.request_date) : "\u2014" }),
          el("span", { class: "status-col", text: p.request_status ? formatRequestStatus(p.request_status) : "\u2014" }),
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

async function renderAddActivityForm(requestId, onLogged, onDirty, onClean) {
  const feedback = el("div");
  const datalistId = `category-options-${_datalistCounter++}`;
  const notesField = buildNotesField();
  const amountInput = el("input", { type: "number", step: "0.01", min: "0", placeholder: "0.00" });
  const categoryInput = el("input", { type: "text", list: datalistId, placeholder: "e.g. groceries, utilities, rent" });
  const payeeNameInput = el("input", { type: "text", placeholder: "e.g. landlord, utility company \u2014 if not the recipient" });
  const dateInput = el("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
  const attachmentField = buildAttachmentUploadField();
  const submitBtn = el("button", { class: "primary", text: "Save Activity" });
  const cancelBtn = el("button", { class: "secondary", type: "button", text: "Cancel" });
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
          payee_name: payeeNameInput.value || null,
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
    if (onClean) onClean();
    if (onLogged) onLogged();
  }});

  form.addEventListener("input", () => { if (onDirty) onDirty(); });
  form.addEventListener("change", () => { if (onDirty) onDirty(); });

  form.appendChild(notesField.root);
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Date" }), dateInput]),
    el("div", { class: "field" }, [el("label", { text: "Category" }), categoryInput]),
    el("div", { class: "field" }, [el("label", { text: "Amount" }), amountInput]),
  ]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Who to make the check out to" }), payeeNameInput]));
  form.appendChild(attachmentField.root);
  form.appendChild(scheduling.root);
  form.appendChild(el("div", { class: "field-row" }, [submitBtn, cancelBtn]));

  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    form.reset();
    feedback.innerHTML = "";
    if (onClean) onClean();
  });

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

function renderEditIdentityForm(identityId, data, onSaved, onCancel) {
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
  const cancelBtn = el("button", { class: "secondary", type: "button", text: "Cancel" });

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
          intake_method: editIntakeChurchRadio.checked ? "church_office_form"
            : editIntakeTeamRadio.checked ? "team_member_entered" : null,
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

  const editIntakeChurchRadio = el("input", { type: "radio", name: "edit_intake_method", value: "church_office_form" });
  const editIntakeTeamRadio = el("input", { type: "radio", name: "edit_intake_method", value: "team_member_entered" });
  if (data.intake_method === "church_office_form") editIntakeChurchRadio.checked = true;
  if (data.intake_method === "team_member_entered") editIntakeTeamRadio.checked = true;
  form.appendChild(el("div", { class: "field" }, [
    el("label", { text: "How was this information received?" }),
    el("label", { class: "checkbox-label" }, [editIntakeChurchRadio, "Form Received from Church Office"]),
    el("label", { class: "checkbox-label" }, [editIntakeTeamRadio, "Entered By Team Member"]),
  ]));

  form.appendChild(el("div", { class: "field-row" }, [submitBtn, cancelBtn]));

  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (onCancel) onCancel();
  });

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function renderAccessHistorySection(logsEndpoint) {
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
        const logs = await api(logsEndpoint);
        if (logs.length === 0) {
          body.appendChild(el("div", { class: "empty-state", text: "No recorded access yet." }));
        } else {
          const list = el("div", { class: "ledger" });
          for (const l of logs) {
            list.appendChild(el("div", { class: "ledger-row" }, [
              el("span", { class: "date", text: formatDateTimeDisplay(l.created_at) }),
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

async function renderEditActivityForm(activity, onSaved, onCancel) {
  const feedback = el("div");
  const datalistId = `category-options-${_datalistCounter++}`;
  const notesField = buildNotesField(activity);
  const amountInput = el("input", { type: "number", step: "0.01", min: "0", value: activity.amount_spent != null ? activity.amount_spent : "" });
  const categoryInput = el("input", { type: "text", list: datalistId, value: activity.category || "" });
  const payeeNameInput = el("input", { type: "text", placeholder: "e.g. landlord, utility company \u2014 if not the recipient", value: activity.payee_name || "" });
  const dateInput = el("input", { type: "date", value: activity.activity_date });
  const attachmentField = buildAttachmentUploadField();
  const submitBtn = el("button", { class: "primary", text: "Save Activity" });
  const cancelBtn = el("button", { class: "secondary", type: "button", text: "Cancel" });
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
          payee_name: payeeNameInput.value || null,
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
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Who to make the check out to" }), payeeNameInput]));
  form.appendChild(attachmentField.root);
  form.appendChild(scheduling.root);
  form.appendChild(el("div", { class: "field-row" }, [submitBtn, cancelBtn]));

  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (onCancel) onCancel();
  });

  const wrap = el("div");
  categoryDatalist(datalistId).then((dl) => wrap.appendChild(dl));
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

function renderActivityRow(a, canEdit, onSaved, requestClosed) {
  const wrap = el("div");
  const statusSuffix = a.status && a.status !== "completed" ? ` \u2014 ${a.status}${a.scheduled_at ? " for " + formatDateTimeDisplay(a.scheduled_at) : ""}` : "";
  const amountText = a.amount_spent != null
    ? money(a.amount_spent) + (a.payment_approved ? "" : " (quote)")
    : "\u2014";

  const amountCol = el("div", { class: "amount-col" });
  amountCol.appendChild(el("span", { class: "amount", text: amountText }));
  if (canEdit && a.amount_spent != null) {
    const approveCb = el("input", { type: "checkbox" });
    approveCb.checked = a.payment_approved;
    if (requestClosed) {
      approveCb.setAttribute("disabled", "true");
      approveCb.title = "This request is closed \u2014 payment approval can no longer be changed";
    }
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
    el("span", { class: "date", text: formatDateDisplay(a.activity_date) }),
    el("span", { class: "category", text: (a.category || "\u2014") + (a.payee_name ? ` \u2014 pay to: ${a.payee_name}` : "") + statusSuffix }),
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

  if (canEdit && !requestClosed) {
    const editToggle = el("button", { class: "link-btn", text: "Edit" });
    const editWrap = el("div", { class: "hidden" });
    editToggle.addEventListener("click", async () => {
      const wasHidden = editWrap.classList.contains("hidden");
      editWrap.classList.toggle("hidden");
      if (wasHidden && editWrap.children.length === 0) {
        editWrap.appendChild(await renderEditActivityForm(a, onSaved, () => {
          editWrap.innerHTML = "";
          editWrap.classList.add("hidden");
        }));
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

function renderNewRequestForm(identityId, onCreated, onCancel) {
  const feedback = el("div");
  const typeInput = el("input", { type: "text", required: "true", placeholder: "What kind of assistance is being requested?" });
  const situationInput = el("textarea", { placeholder: "Their situation, in their own words" });
  const receivedDateInput = el("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
  const helperNameInput = el("input", { type: "text", placeholder: "Helper's name" });
  const helperContactInput = el("input", { type: "text", placeholder: "Helper's phone or email" });
  const helperRelInput = el("input", { type: "text", placeholder: "Helper's relationship to applicant" });
  const paperFormField = buildAttachmentUploadField("Attach the intake paper form (if available)");
  const paymentMethodSelect = el("select", {}, [
    el("option", { value: "", text: "Not yet determined" }),
    el("option", { value: "check", text: "Check" }),
    el("option", { value: "credit_card", text: "Credit Card" }),
  ]);
  const submitBtn = el("button", { class: "primary", text: "Create request" });
  const cancelBtn = el("button", { class: "secondary", type: "button", text: "Cancel" });

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
          payment_method: paymentMethodSelect.value || null,
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
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Payment method" }), paymentMethodSelect]));
  form.appendChild(paperFormField.root);
  form.appendChild(el("p", { class: "lead", text: "If someone helped complete this request:" }));
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Helper name" }), helperNameInput]),
    el("div", { class: "field" }, [el("label", { text: "Helper contact" }), helperContactInput]),
    el("div", { class: "field" }, [el("label", { text: "Relationship" }), helperRelInput]),
  ]));
  form.appendChild(el("div", { class: "field-row" }, [submitBtn, cancelBtn]));

  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (onCancel) onCancel();
  });

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
  ["new", "New"], ["pending_approval", "Pending Approval"], ["approved", "Approved"], ["denied", "Denied"],
  ["in_progress", "In Progress"], ["on_hold", "On Hold"],
  ["completed", "Completed"], ["canceled", "Canceled"],
];

function formatRequestStatus(status) {
  const found = REQUEST_STATUS_OPTIONS.find(([v]) => v === status);
  return found ? found[1] : status;
}

function renderEditRequestForm(req, onSaved, onCancel) {
  const feedback = el("div");
  const typeInput = el("input", { type: "text", required: "true" });
  typeInput.value = req.assistance_type || "";
  const situationInput = el("textarea", {});
  situationInput.value = req.situation_description || "";
  const receivedDateInput = el("input", { type: "date" });
  if (req.request_received_date) receivedDateInput.value = req.request_received_date;
  const helperNameInput = el("input", { type: "text", placeholder: "Helper's name" });
  helperNameInput.value = req.helper_name || "";
  const helperContactInput = el("input", { type: "text", placeholder: "Helper's phone or email" });
  helperContactInput.value = req.helper_contact || "";
  const helperRelInput = el("input", { type: "text", placeholder: "Helper's relationship to applicant" });
  helperRelInput.value = req.helper_relationship || "";
  const paymentMethodSelect = el("select", {}, [
    el("option", { value: "", text: "Not yet determined" }),
    el("option", { value: "check", text: "Check" }),
    el("option", { value: "credit_card", text: "Credit Card" }),
  ]);
  paymentMethodSelect.value = req.payment_method || "";
  const submitBtn = el("button", { class: "primary", text: "Save" });
  const cancelBtn = el("button", { class: "secondary", type: "button", text: "Cancel" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      await api(`/requests/${req.id}`, {
        method: "PUT",
        body: JSON.stringify({
          assistance_type: typeInput.value,
          situation_description: situationInput.value || null,
          status: req.status,
          request_received_date: receivedDateInput.value || null,
          helper_name: helperNameInput.value || null,
          helper_contact: helperContactInput.value || null,
          helper_relationship: helperRelInput.value || null,
          payment_method: paymentMethodSelect.value || null,
        }),
      });
      // Update in place — no full-page refresh needed.
      req.assistance_type = typeInput.value;
      req.situation_description = situationInput.value || null;
      req.request_received_date = receivedDateInput.value || null;
      req.helper_name = helperNameInput.value || null;
      req.helper_contact = helperContactInput.value || null;
      req.helper_relationship = helperRelInput.value || null;
      req.payment_method = paymentMethodSelect.value || null;
      if (onSaved) onSaved();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Assistance requested" }), typeInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Situation" }), situationInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Request received date" }), receivedDateInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Payment method" }), paymentMethodSelect]));
  form.appendChild(el("p", { class: "lead", text: "If someone helped complete this request:" }));
  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Helper name" }), helperNameInput]),
    el("div", { class: "field" }, [el("label", { text: "Helper contact" }), helperContactInput]),
    el("div", { class: "field" }, [el("label", { text: "Relationship" }), helperRelInput]),
  ]));
  form.appendChild(el("div", { class: "field-row" }, [submitBtn, cancelBtn]));

  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (onCancel) onCancel();
  });

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

async function renderRequestCard(req, identityId, isHidden, onChanged) {
  const card = el("div", { class: "identity-card" });
  let voteButtonsContainer = null; // set once the vote section builds; status handler hides this if closed
  let voteClosedMessage = null;
  let editRequestToggle = null;
  let editRequestWrap = null;
  let statusSelectRef = null; // locked while the Add-activity form is open, so an in-progress entry can't be orphaned by a status change

  const summaryRow = el("div", { class: "request-row" });
  summaryRow.appendChild(el("span", { class: "req-date", text: req.request_received_date ? formatDateDisplay(req.request_received_date) : "\u2014" }));

  const expandLink = el("button", { class: "link-btn req-need", text: req.assistance_type || "Hidden" });
  summaryRow.appendChild(expandLink);

  const alreadyClosed = ["denied", "completed", "canceled"].includes(req.status) && currentUser.role !== "admin";
  if (canEdit() && !isHidden && !alreadyClosed) {
    const statusSelect = el("select", { class: "req-status" }, REQUEST_STATUS_OPTIONS.map(([v, l]) => el("option", { value: v, text: l })));
    statusSelectRef = statusSelect;
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
        const nowClosed = ["denied", "completed", "canceled"].includes(req.status);
        if (nowClosed && voteButtonsContainer) {
          voteButtonsContainer.remove();
          voteButtonsContainer = null;
          if (voteClosedMessage) voteClosedMessage.textContent = "Voting is closed for this request.";
        }
        if (nowClosed && currentUser.role !== "admin") {
          // The request just closed — swap the editable dropdown for
          // plain text and pull the Edit control, matching what a
          // fresh page load would show for an already-closed request.
          // Admin keeps both regardless, per their status override.
          statusSelect.replaceWith(el("span", { class: "req-status", text: formatRequestStatus(req.status) }));
          statusFeedback.remove();
          if (editRequestToggle) editRequestToggle.remove();
          if (editRequestWrap) editRequestWrap.remove();
        }
      } catch (err) {
        statusFeedback.textContent = err.message;
      }
    });
    summaryRow.appendChild(statusSelect);
    summaryRow.appendChild(statusFeedback);
  } else {
    summaryRow.appendChild(el("span", { class: "req-status", text: formatRequestStatus(req.status) }));
  }

  const isClosed = ["denied", "completed", "canceled"].includes(req.status) && currentUser.role !== "admin";

  summaryRow.appendChild(el("span", { class: "req-amount", text: money(req.total_amount) }));

  const viewActivitiesToggle = el("button", { class: "link-btn", text: "View Details" });
  summaryRow.appendChild(viewActivitiesToggle);

  card.appendChild(summaryRow);

  let updateSituationDisplay = null;
  if (!isHidden) {
    const situationDisplay = el("div", { class: "lead req-situation" });
    updateSituationDisplay = () => {
      situationDisplay.innerHTML = "";
      situationDisplay.appendChild(el("strong", { text: "Situation: " }));
      situationDisplay.appendChild(document.createTextNode(req.situation_description || "\u2014"));
    };
    updateSituationDisplay();
    card.appendChild(situationDisplay);
  }

  const body = el("div", { class: "hidden" });
  card.appendChild(body);

  expandLink.addEventListener("click", () => {
    body.classList.toggle("hidden");
  });

  if (!isHidden) {
    const detailsWrap = el("div");
    function renderDetailsDl() {
      detailsWrap.innerHTML = "";
      detailsWrap.appendChild(el("dl", {}, [
        el("dt", { text: "Request received" }), el("dd", { text: req.request_received_date ? formatDateDisplay(req.request_received_date) : "\u2014" }),
        el("dt", { text: "Payment method" }), el("dd", { text: req.payment_method === "check" ? "Check" : req.payment_method === "credit_card" ? "Credit Card" : "\u2014" }),
        el("dt", { text: "Helper" }), el("dd", { text: req.helper_name ? `${req.helper_name} \u2014 ${req.helper_contact || ""} (${req.helper_relationship || ""})` : "\u2014" }),
      ]));
    }
    renderDetailsDl();
    body.appendChild(detailsWrap);

    let editRequestBtn = null;
    const editWrap = el("div", { class: "hidden" });
    if (canEdit() && !isClosed) {
      editRequestBtn = el("button", { class: "link-btn", text: "Edit request" });
      editRequestBtn.addEventListener("click", () => {
        editWrap.classList.toggle("hidden");
        if (editWrap.children.length === 0) {
          editWrap.appendChild(renderEditRequestForm(req, () => {
            renderDetailsDl();
            if (updateSituationDisplay) updateSituationDisplay();
            expandLink.textContent = req.assistance_type || "Hidden";
            const dateSpan = summaryRow.querySelector(".req-date");
            if (dateSpan) dateSpan.textContent = req.request_received_date ? formatDateDisplay(req.request_received_date) : "\u2014";
            editWrap.innerHTML = "";
            editWrap.classList.add("hidden");
          }, () => {
            editWrap.innerHTML = "";
            editWrap.classList.add("hidden");
          }));
        }
      });
      body.appendChild(editRequestBtn);
      body.appendChild(editWrap);
    } else if (isClosed) {
      body.appendChild(el("p", { class: "lead", text: "This request is closed and can no longer be edited." }));
    }
    editRequestToggle = editRequestBtn;
    editRequestWrap = editWrap;

    const docSection = el("section");
    docSection.appendChild(el("h2", { text: "Documents" }));
    let docsBuilt = false;
    async function buildDocs() {
      if (docsBuilt) return;
      docsBuilt = true;
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
    }
    buildDocs();
    body.appendChild(docSection);
  }

  // Votes only apply during the Pending Approval phase — hidden
  // entirely for every other status, not just when closed.
  if (!isHidden && req.status === "pending_approval") {
    const voteSection = el("section");
    voteSection.appendChild(el("h2", { text: "Team vote" }));

    const votingClosed = ["denied", "completed", "canceled"].includes(req.status);
    const closedMsg = el("p", { class: "lead", text: votingClosed ? "Voting is closed for this request." : "Do you support this request?" });
    voteClosedMessage = closedMsg;
    voteSection.appendChild(closedMsg);

    const votersList = el("div", { class: "ledger" });
    const renderVoters = () => {
      votersList.innerHTML = "";
      if (req.votes.voters.length === 0) {
        votersList.appendChild(el("div", { class: "empty-state", text: "No votes yet." }));
        return;
      }
      for (const v of req.votes.voters) {
        votersList.appendChild(el("div", { class: "ledger-row" }, [
          el("span", { class: "category", text: v.name }),
          el("span", { class: "amount", text: v.support ? "Yes" : "No" }),
        ]));
      }
    };
    renderVoters();

    const voteTally = el("p", { class: "lead" });
    const updateTally = () => {
      voteTally.textContent = `${req.votes.yes} yes \u00b7 ${req.votes.no} no`;
    };
    updateTally();

    if (!votingClosed) {
      const yesBtn = el("button", { class: req.votes.my_vote === true ? "primary" : "secondary", text: "Yes" });
      const noBtn = el("button", { class: req.votes.my_vote === false ? "primary" : "secondary", text: "No" });
      const myVoteIndicator = el("p", { class: "lead" });
      const updateMyVoteIndicator = () => {
        myVoteIndicator.textContent = req.votes.my_vote === true ? "\u2713 You voted Yes"
          : req.votes.my_vote === false ? "\u2713 You voted No"
          : "";
      };
      updateMyVoteIndicator();
      const voteFeedback = el("div");
      async function castVote(support) {
        voteFeedback.innerHTML = "";
        try {
          await api(`/requests/${req.id}/vote`, { method: "PUT", body: JSON.stringify({ support }) });
          const myName = currentUser.full_name || currentUser.email || currentUser.username;
          const existingVoter = req.votes.voters.find((v) => v.name === myName);
          if (req.votes.my_vote === true) req.votes.yes--;
          if (req.votes.my_vote === false) req.votes.no--;
          if (support) req.votes.yes++; else req.votes.no++;
          req.votes.my_vote = support;
          if (existingVoter) {
            existingVoter.support = support;
          } else {
            req.votes.voters.push({ name: myName, support });
          }
          yesBtn.className = support === true ? "primary" : "secondary";
          noBtn.className = support === false ? "primary" : "secondary";
          updateTally();
          updateMyVoteIndicator();
          renderVoters();
        } catch (err) {
          voteFeedback.appendChild(msg(err.message, "error"));
        }
      }
      yesBtn.addEventListener("click", () => castVote(true));
      noBtn.addEventListener("click", () => castVote(false));

      voteButtonsContainer = el("div", { class: "field-row" }, [yesBtn, noBtn]);
      voteSection.appendChild(voteButtonsContainer);
      voteSection.appendChild(myVoteIndicator);
      voteSection.appendChild(voteFeedback);
    }

    voteSection.appendChild(voteTally);
    voteSection.appendChild(votersList);
    card.appendChild(voteSection);
  }


  const activitiesBody = el("div", { class: "hidden" });
  card.appendChild(activitiesBody);

  let activitiesBuilt = false;
  viewActivitiesToggle.addEventListener("click", async (e) => {
    e.stopPropagation();
    const nowHidden = activitiesBody.classList.toggle("hidden");
    viewActivitiesToggle.textContent = nowHidden ? "View Details" : "Hide Details";

    if (activitiesBuilt) return;
    activitiesBuilt = true;

    const activitySection = el("section");
    activitySection.appendChild(el("h2", { text: "Activity" }));
    const list = el("div", { class: "ledger" });
    const requestClosed = ["denied", "completed", "canceled"].includes(req.status);
    if (req.activities.length === 0) {
      list.appendChild(el("div", { class: "empty-state", text: "No activity logged yet." }));
    } else {
      for (const a of req.activities) {
        list.appendChild(renderActivityRow(a, canEdit(), onChanged, requestClosed));
      }
    }
    activitySection.appendChild(list);
    activitiesBody.appendChild(activitySection);

    if (canEdit() && !requestClosed) {
      const addSection = el("section");
      addSection.appendChild(el("h2", { text: "Add activity" }));
      addSection.appendChild(await renderAddActivityForm(req.id, onChanged, () => {
        if (statusSelectRef) {
          statusSelectRef.disabled = true;
          statusSelectRef.title = "Finish or cancel your in-progress activity entry to change status";
        }
      }, () => {
        if (statusSelectRef) {
          statusSelectRef.disabled = false;
          statusSelectRef.title = "";
        }
      }));
      activitiesBody.appendChild(addSection);
    } else if (requestClosed) {
      activitiesBody.appendChild(el("p", { class: "lead", text: "This request is closed \u2014 activities can no longer be added." }));
    }
  });

  return card;
}

async function renderPersonDetail(identityId, onBack) {
  if (_presencePollInterval) { clearInterval(_presencePollInterval); _presencePollInterval = null; }
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

  const presenceLine = el("p", { class: "lead" });
  container.appendChild(presenceLine);
  const changeBanner = el("div");
  container.appendChild(changeBanner);

  const loadedSnapshot = JSON.stringify(data);
  _presencePollInterval = setInterval(async () => {
    try {
      const presence = await api(`/identities/${identityId}/presence`, { method: "POST" });
      presenceLine.textContent = presence.others_present.length > 0
        ? `Also viewing this record right now: ${presence.others_present.map((p) => p.name).join(", ")}`
        : "";

      if (changeBanner.children.length === 0) {
        const fresh = await api(`/people/${identityId}`);
        if (JSON.stringify(fresh) !== loadedSnapshot) {
          const banner = msg("This record has been updated since you loaded it.", "info");
          const refreshBtn = el("button", { class: "secondary", text: "Refresh" });
          refreshBtn.addEventListener("click", refresh);
          changeBanner.appendChild(banner);
          changeBanner.appendChild(refreshBtn);
        }
      }
    } catch (e) {
      // Presence/change checks are best-effort — never disrupt the page over a failed poll.
    }
  }, 15000);

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
    editWrap.appendChild(renderEditIdentityForm(identityId, data, refresh, () => {
      editWrap.classList.add("hidden");
    }));
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
          el("span", { class: "move-date", text: formatDateDisplay(a.effective_date) + " \u2014 " }),
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
      if (newReqWrap.children.length === 0) newReqWrap.appendChild(renderNewRequestForm(identityId, refresh, () => {
        newReqWrap.innerHTML = "";
        newReqWrap.classList.add("hidden");
      }));
    });
    reqSection.appendChild(newReqToggle);
    reqSection.appendChild(newReqWrap);
  }
  container.appendChild(reqSection);

  if (currentUser.role === "admin" || currentUser.role === "teammember") {
    container.appendChild(renderAccessHistorySection(`/identities/${identityId}/logs`));
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

function renderFinancialSecretaryIntakeFlow(onBack) {
  renderNewPersonPage((newIdentityId) => {
    main.innerHTML = "";
    const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Cancel and return" });
    backLink.addEventListener("click", onBack);
    main.appendChild(backLink);
    main.appendChild(el("h1", { text: "Add Their Request" }));
    main.appendChild(el("p", { class: "lead", text: "Recipient saved. Now add the request they're asking about, and attach the paper intake form if you have it." }));
    main.appendChild(renderNewRequestForm(newIdentityId, () => {
      main.innerHTML = "";
      main.appendChild(el("h1", { text: "Done" }));
      main.appendChild(msg("Recipient and request created successfully. The team will take it from here.", "success"));
      const doneBtn = el("button", { class: "primary", text: "Return to dashboard" });
      doneBtn.addEventListener("click", onBack);
      main.appendChild(doneBtn);
    }, onBack));
  }, onBack);
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
  const cancelBtn = el("button", { class: "secondary", type: "button", text: "Cancel" });
  cancelBtn.addEventListener("click", (e) => { e.preventDefault(); onBack(); });

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

  const intakeChurchRadio = el("input", { type: "radio", name: "intake_method", value: "church_office_form", required: "true" });
  const intakeTeamRadio = el("input", { type: "radio", name: "intake_method", value: "team_member_entered", required: "true" });
  referralSection.appendChild(el("div", { class: "field" }, [
    el("label", { text: "How was this information received?" }),
    el("label", { class: "checkbox-label" }, [intakeChurchRadio, "Form Received from Church Office"]),
    el("label", { class: "checkbox-label" }, [intakeTeamRadio, "Entered By Team Member"]),
  ]));

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
          intake_method: intakeChurchRadio.checked ? "church_office_form" : "team_member_entered",
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
  form.appendChild(el("div", { class: "field-row" }, [submitBtn, cancelBtn]));
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
      const roster = (await api("/users")).filter((u) => u.role !== "volunteer" && u.is_active);
      if (roster.length === 0) {
        body.appendChild(el("div", { class: "empty-state", text: "No other team members yet." }));
      } else {
        const list = el("div", { class: "ledger" });
        for (const u of roster) {
          list.appendChild(el("div", { class: "ledger-row" }, [
            el("span", { class: "date", text: u.full_name || u.username || "\u2014" }),
            el("span", { class: "category", text: `${u.email || "\u2014"} (${roleLabel(u.role)})` }),
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
    el("option", { value: "financial_secretary", text: "Financial Secretary" }),
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
  const removeBtn = el("button", { class: "secondary", text: u.is_active ? "Deactivate account now" : "Reactivate account" });

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

  const resetBtn = el("button", { class: "secondary", text: "Send password reset" });
  const resetFeedback = el("div");
  resetBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    resetFeedback.innerHTML = "";
    resetBtn.setAttribute("disabled", "true");
    try {
      await api(`/users/${u.id}/send-password-reset`, { method: "POST" });
      resetFeedback.appendChild(msg("Reset link sent.", "success"));
    } catch (err) {
      resetFeedback.appendChild(msg(err.message, "error"));
    } finally {
      resetBtn.removeAttribute("disabled");
    }
  });

  const wrap = el("div");
  wrap.appendChild(el("h3", { text: "Role & term" }));
  wrap.appendChild(el("div", { class: "field" }, [el("label", { text: "Role" }), roleSelect]));
  wrap.appendChild(termFields);
  wrap.appendChild(saveBtn);
  wrap.appendChild(el("h3", { text: "Password" }));
  wrap.appendChild(el("p", { class: "lead", text: "Sends them a fresh sign-in link (same mechanism as normal sign-in) \u2014 once they're in, they can set a new password from My Info without needing the old one." }));
  wrap.appendChild(resetBtn);
  wrap.appendChild(resetFeedback);
  wrap.appendChild(el("h3", { text: "Account status" }));
  wrap.appendChild(el("p", { class: "lead", text: u.is_active
    ? "Deactivate immediately, regardless of term dates. They'll be signed out and blocked from logging in right away."
    : "This account is currently deactivated and cannot sign in." }));
  wrap.appendChild(removeBtn);
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

    // Invite lives here, under the roster, rather than as its own
    // top-level button — it's part of managing the team, not a
    // separate everyday action.
    const invite = renderInviteSection(true);
    body.appendChild(invite.toggle);
    body.appendChild(invite.body);
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
    el("option", { value: "financial_secretary", text: "Financial Secretary" }),
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

function fiscalYearOf(d) {
  return d.getMonth() + 1 >= 9 ? d.getFullYear() + 1 : d.getFullYear();
}
function fiscalYearStart(fyEndingYear) {
  return new Date(fyEndingYear - 1, 8, 1); // Sept 1 (month index 8)
}
function toDateInputValue(d) {
  return d.toISOString().slice(0, 10);
}

const REQUEST_STATUS_FILTER_OPTIONS = [
  ["", "All statuses"],
  ["new", "New"], ["pending_approval", "Pending Approval"], ["approved", "Approved"], ["denied", "Denied"],
  ["in_progress", "In Progress"], ["on_hold", "On Hold"],
  ["completed", "Completed"], ["canceled", "Canceled"],
];

async function renderRequestsAndVotesPage(onNavigate, onBack) {
  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to recipients" });
  backLink.addEventListener("click", onBack);
  main.appendChild(backLink);

  main.appendChild(el("h1", { text: "Requests & Votes" }));
  const refreshBtn = el("button", { class: "secondary", text: "Refresh" });
  main.appendChild(refreshBtn);
  main.appendChild(el("p", { class: "lead", text: "Every request that isn't denied, completed, or canceled, with the team's vote tally." }));

  let unvotedOnly = false;
  const filterCb = el("input", { type: "checkbox" });
  const filterLabel = el("label", { class: "checkbox-label" }, [filterCb, "Show only requests I haven't voted on"]);
  filterCb.addEventListener("change", () => { unvotedOnly = filterCb.checked; refresh(); });
  main.appendChild(el("div", { class: "field" }, [filterLabel]));

  const body = el("div");
  main.appendChild(body);

  async function refresh() {
    body.innerHTML = "";
    try {
      const params = unvotedOnly ? "?unvoted_only=true" : "";
      const requests = await api(`/requests/open${params}`);
      if (requests.length === 0) {
        body.appendChild(el("div", { class: "empty-state", text: unvotedOnly ? "Nothing left for you to vote on." : "No open requests right now." }));
        return;
      }

      const head = el("div", { class: "request-row request-row-head" }, [
        el("span", { class: "req-date", text: "Date" }),
        el("span", { class: "req-need", text: "Recipient / Need" }),
        el("span", { class: "req-status", text: "Status" }),
        el("span", { class: "req-status", text: "Votes" }),
        el("span", { class: "req-amount", text: "Total" }),
      ]);
      body.appendChild(head);

      for (const r of requests) {
        const label = r.name ? `${r.name} \u2014 ${r.assistance_type || ""}` : "Hidden";
        const row = el("div", {
          class: "request-row clickable-row",
          onclick: () => onNavigate(r.identity_id),
        }, [
          el("span", { class: "req-date", text: r.request_received_date ? formatDateDisplay(r.request_received_date) : "\u2014" }),
          el("span", { class: "req-need", text: label }),
          el("span", { class: "req-status", text: formatRequestStatus(r.status) }),
          el("span", { class: "req-status", text: `Y=${r.yes_votes}/N=${r.no_votes}` }),
          el("span", { class: "req-amount", text: money(r.total_amount) }),
        ]);
        body.appendChild(row);
      }
    } catch (err) {
      body.appendChild(msg(err.message, "error"));
    }
  }

  refreshBtn.addEventListener("click", refresh);
  await refresh();
}

async function renderAccessLogsPage(onNavigate, onBack) {
  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to recipients" });
  backLink.addEventListener("click", onBack);
  main.appendChild(backLink);

  main.appendChild(el("h1", { text: "Access Logs" }));
  const refreshBtn = el("button", { class: "secondary", text: "Refresh" });
  main.appendChild(refreshBtn);
  main.appendChild(el("p", { class: "lead", text: "Every time a recipient's PII was decrypted, system-wide \u2014 who looked, and when." }));

  let page = 1;
  const body = el("div");
  main.appendChild(body);
  const pagerRow = el("div", { class: "button-row" });
  main.appendChild(pagerRow);

  async function refresh() {
    body.innerHTML = "";
    pagerRow.innerHTML = "";
    try {
      const data = await api(`/identities/access-logs?page=${page}&per_page=50`);
      if (data.logs.length === 0) {
        body.appendChild(el("div", { class: "empty-state", text: "No access recorded yet." }));
        return;
      }

      const head = el("div", { class: "ledger-row" }, [
        el("span", { class: "date", text: "When" }),
        el("span", { class: "category", text: "Recipient" }),
        el("span", { class: "amount", text: "Viewed by" }),
      ]);
      body.appendChild(head);

      for (const log of data.logs) {
        const row = el("button", {
          class: "ledger-row ledger-row-btn",
          onclick: () => onNavigate(log.identity_id),
        }, [
          el("span", { class: "date", text: formatDateTimeDisplay(log.accessed_at) }),
          el("span", { class: "category", text: log.recipient_name }),
          el("span", { class: "amount", text: log.user_name + (log.via_elevation ? " (elevated)" : "") }),
        ]);
        body.appendChild(row);
      }

      pagerRow.appendChild(el("p", { class: "lead", text: `Page ${data.page} of ${data.total_pages} \u2014 ${data.total_count} total` }));
      const prevBtn = el("button", { class: "secondary", text: "\u2190 Previous" });
      const nextBtn = el("button", { class: "secondary", text: "Next \u2192" });
      if (page <= 1) prevBtn.setAttribute("disabled", "true");
      if (page >= data.total_pages) nextBtn.setAttribute("disabled", "true");
      prevBtn.addEventListener("click", () => { page--; refresh(); });
      nextBtn.addEventListener("click", () => { page++; refresh(); });
      pagerRow.appendChild(prevBtn);
      pagerRow.appendChild(nextBtn);
    } catch (err) {
      body.appendChild(msg(err.message, "error"));
    }
  }

  refreshBtn.addEventListener("click", refresh);
  await refresh();
}

let _checkRegisterPresenceInterval = null;

async function renderCheckRegisterPage(onNavigate, onBack) {
  if (_checkRegisterPresenceInterval) { clearInterval(_checkRegisterPresenceInterval); _checkRegisterPresenceInterval = null; }
  const wrappedOnBack = () => {
    if (_checkRegisterPresenceInterval) { clearInterval(_checkRegisterPresenceInterval); _checkRegisterPresenceInterval = null; }
    onBack();
  };

  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to recipients" });
  backLink.addEventListener("click", wrappedOnBack);
  main.appendChild(backLink);

  main.appendChild(el("h1", { text: "Check Register" }));
  const refreshBtn = el("button", { class: "secondary", text: "Refresh" });
  main.appendChild(refreshBtn);
  const viewersLine = el("p", { class: "lead" });
  main.appendChild(viewersLine);

  async function sendHeartbeat() {
    try {
      const result = await api("/check-register/presence", { method: "POST" });
      const myName = currentUser.full_name || currentUser.email || currentUser.username;
      const others = result.viewers.filter((v) => v.name !== myName);
      viewersLine.textContent = others.length > 0 ? `Also here now: ${others.map((v) => v.name).join(", ")}` : "";
    } catch (err) { /* non-critical */ }
  }
  await sendHeartbeat();
  _checkRegisterPresenceInterval = setInterval(sendHeartbeat, 15000);

  const body = el("div");
  main.appendChild(body);

  async function refresh() {
    body.innerHTML = "";
    try {
      const data = await api("/check-register");

      const currentFy = fiscalYearOf(new Date());
      const currentFyBudget = data.fiscal_year_budgets[currentFy] || 0;
      const currentFyBudgetUsed = data.fiscal_year_budget_used[currentFy] || 0;
      const unusedBudget = Math.max(0, currentFyBudget - currentFyBudgetUsed);
      const totalAvailable = data.designated_balance + unusedBudget;

      const totalStrip = el("div", { class: "totals-strip" });
      totalStrip.appendChild(el("div", { class: "stat" }, [
        el("span", { class: "label", text: "Total available funds" }),
        el("span", { class: "value", text: `${money(totalAvailable)} (${money(unusedBudget)} unused budget | ${money(data.designated_balance)} account balance)` }),
      ]));
      body.appendChild(totalStrip);

      const strip = el("div", { class: "totals-strip" });
      strip.appendChild(el("div", { class: "stat" }, [el("span", { class: "label", text: "Designated fund balance" }), el("span", { class: "value", text: money(data.designated_balance) })]));
      strip.appendChild(el("div", { class: "stat" }, [
        el("span", { class: "label", text: `FY${currentFy} budget` }),
        el("span", { class: "value", text: money(currentFyBudget) }),
      ]));
      strip.appendChild(el("div", { class: "stat" }, [
        el("span", { class: "label", text: `FY${currentFy} budget used` }),
        el("span", { class: "value", text: money(currentFyBudgetUsed) }),
      ]));
      body.appendChild(strip);

      // Starting balance
      const startSection = el("section", { class: "cr-section" });
      const startFormWrap = el("div", { class: data.starting_date ? "hidden" : "" });
      if (data.starting_date) {
        const startTitleToggle = el("button", { class: "h2-toggle", text: "Starting balance" });
        startTitleToggle.addEventListener("click", () => startFormWrap.classList.toggle("hidden"));
        startSection.appendChild(startTitleToggle);
      } else {
        startSection.appendChild(el("h2", { text: "Starting balance" }));
      }
      startSection.appendChild(el("p", { class: "lead", text: data.starting_date
        ? `Currently set to ${money(data.starting_balance)} as of ${formatDateDisplay(data.starting_date)}.`
        : "Not set yet \u2014 enter the initial donation balance to begin." }));

      const startBalanceInput = el("input", { type: "number", step: "0.01", placeholder: "0.00" });
      const startDateInput = el("input", { type: "date" });
      const startBtn = el("button", { class: "secondary", text: "Set starting balance" });
      const startFeedback = el("div");
      startBtn.addEventListener("click", async () => {
        startFeedback.innerHTML = "";
        try {
          await api("/check-register/starting-balance", {
            method: "POST",
            body: JSON.stringify({ balance: parseFloat(startBalanceInput.value), as_of_date: startDateInput.value }),
          });
          refresh();
        } catch (err) {
          startFeedback.appendChild(msg(err.message, "error"));
        }
      });
      startFormWrap.appendChild(el("div", { class: "field-row" }, [
        el("div", { class: "field" }, [el("label", { text: "Balance" }), startBalanceInput]),
        el("div", { class: "field" }, [el("label", { text: "As of date" }), startDateInput]),
      ]));
      startFormWrap.appendChild(startBtn);
      startFormWrap.appendChild(startFeedback);
      startSection.appendChild(startFormWrap);
      body.appendChild(startSection);

      // Fiscal year budget
      const budgetSection = el("section", { class: "cr-section" });
      const budgetFormWrap = el("div", { class: "hidden" });
      const budgetTitleToggle = el("button", { class: "h2-toggle", text: "Annual budget" });
      budgetTitleToggle.addEventListener("click", () => budgetFormWrap.classList.toggle("hidden"));
      budgetSection.appendChild(budgetTitleToggle);
      budgetSection.appendChild(el("p", { class: "lead", text: `FY${currentFy} budget: ${money(currentFyBudget)}. Subject to change each September 1.` }));

      const budgetYearInput = el("input", { type: "number", value: currentFy, placeholder: "Fiscal year" });
      const budgetAmountInput = el("input", { type: "number", step: "0.01", placeholder: "0.00" });
      const budgetBtn = el("button", { class: "secondary", text: "Set budget" });
      const budgetFeedback = el("div");
      budgetBtn.addEventListener("click", async () => {
        budgetFeedback.innerHTML = "";
        try {
          await api("/check-register/fiscal-year-budget", {
            method: "POST",
            body: JSON.stringify({ fiscal_year: parseInt(budgetYearInput.value, 10), budget_amount: parseFloat(budgetAmountInput.value) }),
          });
          refresh();
        } catch (err) {
          budgetFeedback.appendChild(msg(err.message, "error"));
        }
      });
      budgetFormWrap.appendChild(el("div", { class: "field-row" }, [
        el("div", { class: "field" }, [el("label", { text: "Fiscal year" }), budgetYearInput]),
        el("div", { class: "field" }, [el("label", { text: "Budget amount" }), budgetAmountInput]),
      ]));
      budgetFormWrap.appendChild(budgetBtn);
      budgetFormWrap.appendChild(budgetFeedback);
      budgetSection.appendChild(budgetFormWrap);
      body.appendChild(budgetSection);

      // Income
      const incomeSection = el("section", { class: "cr-section" });
      const incomeFormWrap = el("div", { class: "hidden" });
      const incomeTitleToggle = el("button", { class: "h2-toggle", text: "Record income" });
      incomeTitleToggle.addEventListener("click", () => incomeFormWrap.classList.toggle("hidden"));
      incomeSection.appendChild(incomeTitleToggle);

      const incomeDateInput = el("input", { type: "date" });
      const incomeAmountInput = el("input", { type: "number", step: "0.01", placeholder: "0.00" });
      const incomeBtn = el("button", { class: "primary", text: "Record donation" });
      const incomeFeedback = el("div");
      incomeBtn.addEventListener("click", async () => {
        incomeFeedback.innerHTML = "";
        try {
          await api("/check-register/income", {
            method: "POST",
            body: JSON.stringify({ transaction_date: incomeDateInput.value, amount: parseFloat(incomeAmountInput.value) }),
          });
          refresh();
        } catch (err) {
          incomeFeedback.appendChild(msg(err.message, "error"));
        }
      });
      incomeFormWrap.appendChild(el("div", { class: "field-row" }, [
        el("div", { class: "field" }, [el("label", { text: "Date" }), incomeDateInput]),
        el("div", { class: "field" }, [el("label", { text: "Amount donated" }), incomeAmountInput]),
      ]));
      incomeFormWrap.appendChild(incomeBtn);
      incomeFormWrap.appendChild(incomeFeedback);
      incomeSection.appendChild(incomeFormWrap);
      body.appendChild(incomeSection);

      // Standalone expense (bank charges, fees — not tied to any request)
      const otherExpenseSection = el("section", { class: "cr-section" });
      const oeFormWrap = el("div", { class: "hidden" });
      const oeTitleToggle = el("button", { class: "h2-toggle", text: "Record other expense" });
      oeTitleToggle.addEventListener("click", () => oeFormWrap.classList.toggle("hidden"));
      otherExpenseSection.appendChild(oeTitleToggle);
      otherExpenseSection.appendChild(el("p", { class: "lead", text: "For bank charges, service fees, or anything else paid straight out of the account \u2014 not tied to a recipient's request." }));

      const oeDateInput = el("input", { type: "date" });
      const oeAmountInput = el("input", { type: "number", step: "0.01", placeholder: "0.00" });
      const oeCategoryInput = el("input", { type: "text", placeholder: "e.g. bank fee, service charge", required: "true" });
      const oePayeeInput = el("input", { type: "text", placeholder: "Optional" });
      const oeAlreadyPaidCb = el("input", { type: "checkbox" });
      oeAlreadyPaidCb.checked = true;
      const oeDatePaidInput = el("input", { type: "date" });
      const oeCheckNumInput = el("input", { type: "text", placeholder: "Leave blank if auto-deducted (e.g. a bank fee)" });
      const oeBtn = el("button", { class: "primary", text: "Record expense" });
      const oeFeedback = el("div");
      oeBtn.addEventListener("click", async () => {
        oeFeedback.innerHTML = "";
        try {
          await api("/check-register/expense", {
            method: "POST",
            body: JSON.stringify({
              transaction_date: oeDateInput.value,
              amount: parseFloat(oeAmountInput.value),
              category: oeCategoryInput.value,
              payee_name: oePayeeInput.value || null,
              already_paid: oeAlreadyPaidCb.checked,
              date_paid: oeAlreadyPaidCb.checked ? (oeDatePaidInput.value || oeDateInput.value) : null,
              check_number: oeAlreadyPaidCb.checked ? (oeCheckNumInput.value || null) : null,
            }),
          });
          refresh();
        } catch (err) {
          oeFeedback.appendChild(msg(err.message, "error"));
        }
      });
      oeFormWrap.appendChild(el("div", { class: "field-row" }, [
        el("div", { class: "field" }, [el("label", { text: "Date" }), oeDateInput]),
        el("div", { class: "field" }, [el("label", { text: "Amount" }), oeAmountInput]),
        el("div", { class: "field" }, [el("label", { text: "Category" }), oeCategoryInput]),
      ]));
      oeFormWrap.appendChild(el("div", { class: "field" }, [el("label", { text: "Paid to (optional)" }), oePayeeInput]));
      oeFormWrap.appendChild(el("div", { class: "field" }, [el("label", { class: "checkbox-label" }, [oeAlreadyPaidCb, "Already paid \u2014 leave unchecked to record as pending (awaiting a check)"])]));
      oeFormWrap.appendChild(el("div", { class: "field-row" }, [
        el("div", { class: "field" }, [el("label", { text: "Date paid (if different)" }), oeDatePaidInput]),
        el("div", { class: "field" }, [el("label", { text: "Check # (optional)" }), oeCheckNumInput]),
      ]));
      oeFormWrap.appendChild(oeBtn);
      oeFormWrap.appendChild(oeFeedback);
      otherExpenseSection.appendChild(oeFormWrap);
      body.appendChild(otherExpenseSection);

      // Pending expenses awaiting payment
      const pendingSection = el("section", { class: "cr-section" });
      pendingSection.appendChild(el("h2", { text: "Pending expenses" }));
      if (data.pending_expenses.length === 0) {
        pendingSection.appendChild(el("div", { class: "empty-state", text: "Nothing awaiting payment." }));
      } else {
        for (const [idx, p] of [...data.pending_expenses].reverse().entries()) {
          const rowAttrs = { class: "ledger-row" };
          if (p.last_edited_by) {
            rowAttrs.title = `Last edited by ${p.last_edited_by} on ${formatDateTimeDisplay(p.last_edited_at)}`;
          }
          const row = el("div", rowAttrs);
          row.appendChild(el("span", { class: "date", text: formatDateDisplay(p.date) }));
          const pmLabel = p.payment_method === "check" ? " (Check)" : p.payment_method === "credit_card" ? " (Credit Card)" : "";
          const categorySpan = el("span", { class: "category", text: (p.category || "\u2014") + pmLabel });
          if (p.identity_id) {
            categorySpan.classList.add("clickable-row");
            categorySpan.addEventListener("click", () => onNavigate(p.identity_id));
          }
          row.appendChild(categorySpan);
          row.appendChild(el("span", { class: "amount", text: money(p.amount) }));
          const editAmountInput = el("input", { type: "number", step: "0.01", value: p.amount });
          const editCategoryInput = el("input", { type: "text", value: p.category || "" });
          const editPayeeInput = el("input", { type: "text", placeholder: "Who to make the check out to", value: p.payee_name || "" });
          const editPaymentMethodSelect = el("select", {}, [
            el("option", { value: "", text: "Not yet determined" }),
            el("option", { value: "check", text: "Check" }),
            el("option", { value: "credit_card", text: "Credit Card" }),
          ]);
          editPaymentMethodSelect.value = p.payment_method || "";
          const editSaveBtn = el("button", { class: "secondary", text: "Save changes" });
          const editFeedback = el("div");
          editSaveBtn.addEventListener("click", async () => {
            editFeedback.innerHTML = "";
            try {
              await api(`/check-register/expense/${p.id}`, {
                method: "PUT",
                body: JSON.stringify({
                  amount: parseFloat(editAmountInput.value),
                  category: editCategoryInput.value || null,
                  payee_name: editPayeeInput.value || null,
                  payment_method: editPaymentMethodSelect.value || null,
                }),
              });
              refresh();
            } catch (err) {
              editFeedback.appendChild(msg(err.message, "error"));
            }
          });
          const dateePaidInput = el("input", { type: "date" });
          const checkNumInput = el("input", { type: "text", placeholder: "Check #" });
          const payBtn = el("button", { class: "secondary", text: "Mark paid" });
          const payFeedback = el("div");
          payBtn.addEventListener("click", async () => {
            payFeedback.innerHTML = "";
            try {
              await api(`/check-register/expense/${p.id}/pay`, {
                method: "PUT",
                body: JSON.stringify({ date_paid: dateePaidInput.value, check_number: checkNumInput.value }),
              });
              refresh();
            } catch (err) {
              payFeedback.appendChild(msg(err.message, "error"));
            }
          });
          const wrap = el("div", { class: "cr-alt-row" + (idx % 2 === 1 ? " cr-alt-row-shaded" : "") });
          wrap.appendChild(row);
          wrap.appendChild(el("div", { class: "field-row" }, [
            el("div", { class: "field" }, [el("label", { text: "Amount" }), editAmountInput]),
            el("div", { class: "field" }, [el("label", { text: "Category" }), editCategoryInput]),
            el("div", { class: "field" }, [el("label", { text: "Pay to" }), editPayeeInput]),
            el("div", { class: "field" }, [el("label", { text: "Payment method" }), editPaymentMethodSelect]),
            editSaveBtn,
          ]));
          wrap.appendChild(editFeedback);
          wrap.appendChild(el("div", { class: "field-row" }, [dateePaidInput, checkNumInput, payBtn]));
          wrap.appendChild(payFeedback);
          pendingSection.appendChild(wrap);
        }
      }
      body.appendChild(pendingSection);

      // Full ledger
      const ledgerSection = el("section", { class: "cr-section" });
      ledgerSection.appendChild(el("h2", { text: "Ledger" }));
      if (data.transactions.length === 0) {
        ledgerSection.appendChild(el("div", { class: "empty-state", text: "No transactions yet." }));
      } else {
        const head = el("div", { class: "report-row report-row-head" }, [
          el("span", { class: "report-period", text: "Date / Description" }),
          el("span", { class: "report-num", text: "Amount" }),
          el("span", { class: "report-num", text: "From budget" }),
          el("span", { class: "report-aid", text: "Balance" }),
          el("span", { text: "" }),
        ]);
        ledgerSection.appendChild(head);
        for (const [idx, t] of [...data.transactions].reverse().entries()) {
          const label = t.type === "income" ? "Donation" : `${t.category || "Expense"}${t.payee_name ? " to " + t.payee_name : ""}${t.check_number ? " (Check #" + t.check_number + ")" : ""}${!t.check_number && t.payment_method === "credit_card" ? " (Credit Card)" : ""}`;
          const editToggle = el("button", { class: "link-btn", text: "Edit" });
          const rowAttrs = { class: "report-row" };
          if (t.last_edited_by) {
            rowAttrs.title = `Last edited by ${t.last_edited_by} on ${formatDateTimeDisplay(t.last_edited_at)}`;
          }
          const periodSpan = el("span", { class: "report-period", text: `${formatDateDisplay(t.date)} \u2014 ${label}` });
          if (t.identity_id) {
            periodSpan.classList.add("clickable-row");
            periodSpan.addEventListener("click", () => onNavigate(t.identity_id));
          }
          const displayRow = el("div", rowAttrs, [
            periodSpan,
            el("span", { class: "report-num", text: (t.type === "income" ? "+" : "-") + money(t.amount) }),
            el("span", { class: "report-num", text: t.from_budget > 0 ? money(t.from_budget) : "\u2014" }),
            el("span", { class: "report-aid", text: money(t.running_balance) }),
            editToggle,
          ]);

          const editBody = el("div", { class: "hidden" });
          editToggle.addEventListener("click", () => editBody.classList.toggle("hidden"));

          const editFeedback = el("div");
          if (t.type === "income") {
            const dateInput = el("input", { type: "date", value: t.date });
            const amountInput = el("input", { type: "number", step: "0.01", value: t.amount });
            const saveBtn = el("button", { class: "secondary", text: "Save" });
            saveBtn.addEventListener("click", async () => {
              editFeedback.innerHTML = "";
              try {
                await api(`/check-register/income/${t.id}`, {
                  method: "PUT",
                  body: JSON.stringify({ transaction_date: dateInput.value, amount: parseFloat(amountInput.value) }),
                });
                refresh();
              } catch (err) {
                editFeedback.appendChild(msg(err.message, "error"));
              }
            });
            editBody.appendChild(el("div", { class: "field-row" }, [
              el("div", { class: "field" }, [el("label", { text: "Date" }), dateInput]),
              el("div", { class: "field" }, [el("label", { text: "Amount" }), amountInput]),
              saveBtn,
            ]));
          } else {
            const amountInput = el("input", { type: "number", step: "0.01", value: t.amount });
            const categoryInput = el("input", { type: "text", value: t.category || "" });
            const payeeInput = el("input", { type: "text", value: t.payee_name || "" });
            const paymentMethodSelect = el("select", {}, [
              el("option", { value: "", text: "Not yet determined" }),
              el("option", { value: "check", text: "Check" }),
              el("option", { value: "credit_card", text: "Credit Card" }),
            ]);
            paymentMethodSelect.value = t.payment_method || "";
            const datePaidInput = el("input", { type: "date", value: t.date });
            const checkNumInput = el("input", { type: "text", value: t.check_number || "" });
            const saveBtn = el("button", { class: "secondary", text: "Save" });
            saveBtn.addEventListener("click", async () => {
              editFeedback.innerHTML = "";
              try {
                await api(`/check-register/expense/${t.id}`, {
                  method: "PUT",
                  body: JSON.stringify({
                    amount: parseFloat(amountInput.value),
                    category: categoryInput.value || null,
                    payee_name: payeeInput.value || null,
                    payment_method: paymentMethodSelect.value || null,
                    date_paid: datePaidInput.value,
                    check_number: checkNumInput.value,
                  }),
                });
                refresh();
              } catch (err) {
                editFeedback.appendChild(msg(err.message, "error"));
              }
            });
            editBody.appendChild(el("div", { class: "field-row" }, [
              el("div", { class: "field" }, [el("label", { text: "Amount" }), amountInput]),
              el("div", { class: "field" }, [el("label", { text: "Category" }), categoryInput]),
              el("div", { class: "field" }, [el("label", { text: "Pay to" }), payeeInput]),
              el("div", { class: "field" }, [el("label", { text: "Payment method" }), paymentMethodSelect]),
            ]));
            editBody.appendChild(el("div", { class: "field-row" }, [
              el("div", { class: "field" }, [el("label", { text: "Date paid" }), datePaidInput]),
              el("div", { class: "field" }, [el("label", { text: "Check #" }), checkNumInput]),
              saveBtn,
            ]));
          }
          editBody.appendChild(editFeedback);

          const rowWrap = el("div", { class: "cr-alt-row" + (idx % 2 === 1 ? " cr-alt-row-shaded" : "") });
          rowWrap.appendChild(displayRow);
          rowWrap.appendChild(editBody);
          ledgerSection.appendChild(rowWrap);
        }
      }
      body.appendChild(ledgerSection);
    } catch (err) {
      body.appendChild(msg(err.message, "error"));
    }
  }

  refreshBtn.addEventListener("click", refresh);
  await refresh();
}

async function renderRecipientListPage(onNavigate, onBack) {
  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to recipients" });
  backLink.addEventListener("click", onBack);
  main.appendChild(backLink);

  main.appendChild(el("h1", { text: "Recipient List" }));
  const refreshBtn = el("button", { class: "secondary", text: "Refresh" });
  main.appendChild(refreshBtn);
  main.appendChild(el("p", { class: "lead", text: "Every recipient, including anyone with no request yet (intake may have been interrupted partway through)." }));

  let page = 1;
  let perPage = 20;
  let requestStatus = "";
  let requestScope = "";

  const perPageSelect = el("select", {}, [10, 20, 50, 100].map((n) => el("option", { value: String(n), text: `${n} per page` })));
  perPageSelect.value = "20";
  const statusSelect = el("select", {}, REQUEST_STATUS_FILTER_OPTIONS.map(([v, l]) => el("option", { value: v, text: l })));
  const scopeSelect = el("select", {}, [
    el("option", { value: "", text: "Any request scope" }),
    el("option", { value: "open", text: "Has an open request" }),
    el("option", { value: "closed", text: "Has a closed request" }),
  ]);

  main.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Rows per page" }), perPageSelect]),
    el("div", { class: "field" }, [el("label", { text: "Filter by request status" }), statusSelect]),
    el("div", { class: "field" }, [el("label", { text: "Filter by scope" }), scopeSelect]),
  ]));

  const body = el("div");
  main.appendChild(body);
  const pagerRow = el("div", { class: "button-row" });
  main.appendChild(pagerRow);

  async function refresh() {
    body.innerHTML = "";
    pagerRow.innerHTML = "";
    try {
      const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      if (requestStatus) params.set("request_status", requestStatus);
      if (requestScope) params.set("request_scope", requestScope);
      const data = await api(`/people/roster?${params.toString()}`);

      if (data.people.length === 0) {
        body.appendChild(el("div", { class: "empty-state", text: "No recipients match this filter." }));
        return;
      }

      const head = el("div", { class: "people-table-head" }, [
        el("span", { class: "who", text: "Recipient" }),
        el("span", { class: "date-col", text: "Requests" }),
        el("span", { class: "status-col", text: "Total Received" }),
      ]);
      body.appendChild(head);

      const table = el("div", { class: "people-table" });
      for (const p of data.people) {
        const row = el("button", {
          class: "people-row",
          onclick: () => onNavigate(p.identity_id),
        }, [
          el("span", { class: "who", text: p.name || "Hidden" }),
          el("span", { class: "date-col", text: String(p.request_count) }),
          el("span", { class: "status-col", text: money(p.total_received) }),
        ]);
        table.appendChild(row);
      }
      body.appendChild(table);

      const totalPages = data.total_pages;
      pagerRow.appendChild(el("p", { class: "lead", text: `Page ${data.page} of ${totalPages} \u2014 ${data.total_count} recipient${data.total_count !== 1 ? "s" : ""} total` }));
      const prevBtn = el("button", { class: "secondary", text: "\u2190 Previous" });
      const nextBtn = el("button", { class: "secondary", text: "Next \u2192" });
      if (page <= 1) prevBtn.setAttribute("disabled", "true");
      if (page >= totalPages) nextBtn.setAttribute("disabled", "true");
      prevBtn.addEventListener("click", () => { page--; refresh(); });
      nextBtn.addEventListener("click", () => { page++; refresh(); });
      pagerRow.appendChild(prevBtn);
      pagerRow.appendChild(nextBtn);
    } catch (err) {
      body.appendChild(msg(err.message, "error"));
    }
  }

  perPageSelect.addEventListener("change", () => { perPage = parseInt(perPageSelect.value, 10); page = 1; refresh(); });
  statusSelect.addEventListener("change", () => { requestStatus = statusSelect.value; page = 1; refresh(); });
  scopeSelect.addEventListener("change", () => { requestScope = scopeSelect.value; page = 1; refresh(); });
  refreshBtn.addEventListener("click", refresh);

  await refresh();
}

async function renderOverviewReportPage(onBack) {
  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to recipients" });
  backLink.addEventListener("click", onBack);
  main.appendChild(backLink);

  main.appendChild(el("h1", { text: "Overview" }));
  const topRefreshBtn = el("button", { class: "secondary", text: "Refresh" });
  main.appendChild(topRefreshBtn);

  const fundSection = el("section");
  main.appendChild(fundSection);
  async function loadFundSummary() {
    fundSection.innerHTML = "";
    fundSection.appendChild(el("h2", { text: "Fund Balance" }));
    try {
      const fs = await api("/check-register/summary");
      const strip = el("div", { class: "totals-strip" });
      strip.appendChild(el("div", { class: "stat" }, [el("span", { class: "label", text: "Designated fund balance" }), el("span", { class: "value", text: money(fs.designated_balance) })]));
      strip.appendChild(el("div", { class: "stat" }, [el("span", { class: "label", text: "YTD income" }), el("span", { class: "value", text: money(fs.ytd.income) })]));
      strip.appendChild(el("div", { class: "stat" }, [el("span", { class: "label", text: "YTD expenses" }), el("span", { class: "value", text: money(fs.ytd.expenses) })]));
      fundSection.appendChild(strip);
      const strip2 = el("div", { class: "totals-strip" });
      strip2.appendChild(el("div", { class: "stat" }, [el("span", { class: "label", text: "Last FY income" }), el("span", { class: "value", text: money(fs.last_fiscal_year.income) })]));
      strip2.appendChild(el("div", { class: "stat" }, [el("span", { class: "label", text: "Last FY expenses" }), el("span", { class: "value", text: money(fs.last_fiscal_year.expenses) })]));
      strip2.appendChild(el("div", { class: "stat" }, [el("span", { class: "label", text: `FY${fs.current_fiscal_year} budget used` }), el("span", { class: "value", text: money(fs.current_fiscal_year_budget_used) })]));
      fundSection.appendChild(strip2);
    } catch (err) {
      fundSection.appendChild(msg(err.message, "error"));
    }
  }
  await loadFundSummary();

  const today = new Date();
  const currentFy = fiscalYearOf(today);
  const thisFyRange = () => [fiscalYearStart(currentFy), today];
  const lastFyRange = () => [fiscalYearStart(currentFy - 1), new Date(fiscalYearStart(currentFy).getTime() - 24 * 60 * 60 * 1000)];

  const startInput = el("input", { type: "date" });
  const endInput = el("input", { type: "date" });
  const [initStart, initEnd] = thisFyRange();
  startInput.value = toDateInputValue(initStart);
  endInput.value = toDateInputValue(initEnd);

  const runBtn = el("button", { class: "primary", text: "Run report" });
  const fyToggleBtn = el("button", { class: "secondary", text: "Last fiscal year" });
  let showingLastFy = false;

  fyToggleBtn.addEventListener("click", () => {
    showingLastFy = !showingLastFy;
    const [s, e] = showingLastFy ? lastFyRange() : thisFyRange();
    startInput.value = toDateInputValue(s);
    endInput.value = toDateInputValue(e);
    fyToggleBtn.textContent = showingLastFy ? "This fiscal year" : "Last fiscal year";
    refresh();
  });

  main.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Start date" }), startInput]),
    el("div", { class: "field" }, [el("label", { text: "End date" }), endInput]),
  ]));
  main.appendChild(el("div", { class: "button-row" }, [runBtn, fyToggleBtn]));

  const periodHeading = el("h2", { style: "text-align: center;" });
  main.appendChild(periodHeading);
  function updatePeriodHeading() {
    const [thisStart, thisEnd] = thisFyRange();
    const [lastStart, lastEnd] = lastFyRange();
    const s = startInput.value;
    const e = endInput.value;
    if (s === toDateInputValue(thisStart) && e === toDateInputValue(thisEnd)) {
      periodHeading.textContent = "This Fiscal Year";
    } else if (s === toDateInputValue(lastStart) && e === toDateInputValue(lastEnd)) {
      periodHeading.textContent = "Last Fiscal Year";
    } else {
      periodHeading.textContent = `${formatDateDisplay(s)} to ${formatDateDisplay(e)}`;
    }
  }
  updatePeriodHeading();

  main.appendChild(el("p", { class: "lead", text: "Defaults to fiscal-year-to-date (fiscal year runs September 1 \u2013 August 31). Status counts reflect each request's current status, so you can see how many requests from a period ended up filled versus still pending." }));

  const body = el("div");
  main.appendChild(body);

  function buildTable(title, rows) {
    const section = el("section");
    section.appendChild(el("h2", { text: title }));
    if (rows.length === 0) {
      section.appendChild(el("div", { class: "empty-state", text: "No data in this range." }));
      return section;
    }
    const head = el("div", { class: "report-row report-row-head" }, [
      el("span", { class: "report-period", text: "Period" }),
      el("span", { class: "report-num", text: "Open" }),
      el("span", { class: "report-num", text: "Completed" }),
      el("span", { class: "report-num", text: "Canceled" }),
      el("span", { class: "report-num", text: "Denied" }),
      el("span", { class: "report-num", text: "Total" }),
      el("span", { class: "report-aid", text: "Aid given" }),
    ]);
    section.appendChild(head);
    for (const r of rows) {
      section.appendChild(el("div", { class: "report-row" }, [
        el("span", { class: "report-period", text: r.label }),
        el("span", { class: "report-num", text: String(r.open) }),
        el("span", { class: "report-num", text: String(r.completed) }),
        el("span", { class: "report-num", text: String(r.canceled) }),
        el("span", { class: "report-num", text: String(r.denied) }),
        el("span", { class: "report-num", text: String(r.total_requests) }),
        el("span", { class: "report-aid", text: money(r.aid_total) }),
      ]));
    }
    return section;
  }

  async function refresh() {
    updatePeriodHeading();
    body.innerHTML = "";
    try {
      const params = new URLSearchParams({ start_date: startInput.value, end_date: endInput.value });
      const data = await api(`/reports/overview?${params.toString()}`);

      const strip = el("div", { class: "totals-strip" });
      strip.appendChild(el("div", { class: "stat" }, [el("span", { class: "label", text: "Total requests" }), el("span", { class: "value", text: String(data.total_requests) })]));
      strip.appendChild(el("div", { class: "stat" }, [el("span", { class: "label", text: "Total aid given" }), el("span", { class: "value", text: money(data.total_aid) })]));
      body.appendChild(strip);

      body.appendChild(buildTable("By month", data.months));
      body.appendChild(buildTable("By fiscal quarter", data.quarters));
      body.appendChild(buildTable("By fiscal year", data.years));
    } catch (err) {
      body.appendChild(msg(err.message, "error"));
    }
  }

  runBtn.addEventListener("click", refresh);
  topRefreshBtn.addEventListener("click", () => { loadFundSummary(); refresh(); });
  await refresh();
}

function renderMeetingForm(existing, teamRoster, onSaved, onCancel) {
  const feedback = el("div");
  const dt = existing ? new Date(existing.meeting_datetime) : new Date();
  const dateInput = el("input", { type: "date", value: dt.toISOString().slice(0, 10) });
  const timeInput = el("input", { type: "time", value: dt.toTimeString().slice(0, 5) });
  const locationInput = el("input", { type: "text", placeholder: "Location" });
  locationInput.value = existing?.location || "";
  const durationInput = el("input", { type: "number", min: "1", placeholder: "Duration (minutes)" });
  if (existing?.duration_minutes) durationInput.value = existing.duration_minutes;
  const summaryInput = el("textarea", { placeholder: "Meeting summary \u2014 should contain no names or identifying details about any recipient" });
  summaryInput.value = existing?.summary || "";
  const redactedInput = el("textarea", { placeholder: "Redacted transcript \u2014 must contain no names or identifying details about any recipient" });
  redactedInput.value = existing?.redacted_transcript || "";
  const rawInput = el("textarea", { placeholder: "Raw transcript (full, unredacted) \u2014 treated as PII" });
  rawInput.value = existing?.raw_transcript || "";

  const attendeeBoxes = el("div");
  const existingAttendeeIds = new Set(existing?.attendee_user_ids || []);
  const checkboxes = [];
  const eligibleAttendees = teamRoster.filter((u) => u.role !== "volunteer");
  for (const u of eligibleAttendees) {
    const cb = el("input", { type: "checkbox", value: u.id });
    if (existingAttendeeIds.has(u.id)) cb.checked = true;
    checkboxes.push(cb);
    const label = el("label", { class: "checkbox-label" }, [cb, u.full_name || u.email || u.username]);
    attendeeBoxes.appendChild(label);
  }

  const submitBtn = el("button", { class: "primary", text: existing ? "Save" : "Create meeting" });
  const cancelBtn = el("button", { class: "secondary", type: "button", text: "Cancel" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      const payload = {
        meeting_datetime: new Date(`${dateInput.value}T${timeInput.value || "00:00"}`).toISOString(),
        duration_minutes: durationInput.value ? parseInt(durationInput.value, 10) : null,
        location: locationInput.value || null,
        summary: summaryInput.value || null,
        redacted_transcript: redactedInput.value || null,
        raw_transcript: rawInput.value || null,
        attendee_user_ids: checkboxes.filter((cb) => cb.checked).map((cb) => cb.value),
      };
      if (existing) {
        await api(`/meetings/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await api("/meetings", { method: "POST", body: JSON.stringify(payload) });
      }
      if (onSaved) onSaved();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field-row" }, [
    el("div", { class: "field" }, [el("label", { text: "Date" }), dateInput]),
    el("div", { class: "field" }, [el("label", { text: "Time" }), timeInput]),
    el("div", { class: "field" }, [el("label", { text: "Duration (minutes)" }), durationInput]),
  ]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Location" }), locationInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Attendance" }), attendeeBoxes]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Meeting summary" }), summaryInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Redacted transcript (for oversight/Deacons)" }), redactedInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Raw transcript (PII \u2014 admin/teammember only)" }), rawInput]));
  form.appendChild(el("div", { class: "field-row" }, [submitBtn, cancelBtn]));

  cancelBtn.addEventListener("click", (e) => { e.preventDefault(); if (onCancel) onCancel(); });

  const wrap = el("div");
  wrap.appendChild(form);
  wrap.appendChild(feedback);
  return wrap;
}

async function renderMeetingsPage(onBack) {
  main.innerHTML = "";
  const backLink = el("button", { class: "link-btn back-link", text: "\u2190 Back to recipients" });
  backLink.addEventListener("click", onBack);
  main.appendChild(backLink);

  main.appendChild(el("h1", { text: "Meetings" }));
  const refreshBtn = el("button", { class: "secondary", text: "Refresh" });
  refreshBtn.addEventListener("click", () => refresh());
  main.appendChild(refreshBtn);

  const body = el("div");

  if (canEdit()) {
    const newToggle = el("button", { class: "secondary", text: "+ New meeting" });
    const newWrap = el("div", { class: "hidden" });
    newToggle.addEventListener("click", async () => {
      newWrap.classList.toggle("hidden");
      if (newWrap.children.length === 0) {
        const roster = await api("/users");
        newWrap.appendChild(renderMeetingForm(null, roster, () => { newWrap.innerHTML = ""; newWrap.classList.add("hidden"); refresh(); }, () => {
          newWrap.innerHTML = "";
          newWrap.classList.add("hidden");
        }));
      }
    });
    main.appendChild(newToggle);
    main.appendChild(newWrap);
  }

  main.appendChild(body);

  async function refresh() {
    body.innerHTML = "";
    try {
      const meetings = await api("/meetings");
      if (meetings.length === 0) {
        body.appendChild(el("div", { class: "empty-state", text: "No meetings recorded yet." }));
        return;
      }
      for (const m of meetings) {
        body.appendChild(await renderMeetingCard(m, refresh));
      }
    } catch (err) {
      body.appendChild(msg(err.message, "error"));
    }
  }

  await refresh();
}

async function renderMeetingCard(m, onChanged) {
  const card = el("div", { class: "identity-card" });
  const dt = new Date(m.meeting_datetime);
  const dateLabel = formatDateDisplay(dt.toISOString().slice(0, 10));
  const timeLabel = dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const durationSuffix = m.duration_minutes ? ` (${m.duration_minutes} min)` : "";
  const toggle = el("button", { class: "link-btn", text: `${dateLabel} ${timeLabel} \u2014 ${m.location || "No location"}${durationSuffix}` });
  card.appendChild(toggle);
  card.appendChild(el("div", { class: "lead", text: m.summary || "No summary." }));
  card.appendChild(el("div", { class: "lead", text: `Attendance: ${m.attendee_names.length > 0 ? m.attendee_names.join(", ") : "none recorded"}` }));

  const body = el("div", { class: "hidden" });
  card.appendChild(body);
  let built = false;
  toggle.addEventListener("click", async () => {
    body.classList.toggle("hidden");
    if (built) return;
    built = true;

    body.appendChild(el("h2", { text: "Redacted transcript" }));
    body.appendChild(el("p", { class: "lead", style: "white-space: pre-wrap;", text: m.redacted_transcript || "No redacted transcript provided." }));

    if (m.has_raw_transcript || m.raw_transcript) {
      if (m.raw_transcript) {
        body.appendChild(el("h2", { text: "Raw transcript" }));
        body.appendChild(el("p", { class: "lead", style: "white-space: pre-wrap;", text: m.raw_transcript }));
      } else {
        body.appendChild(el("p", { class: "lead", text: "A raw transcript exists but you don't currently have permission to view it." }));
      }
    }

    if (canEdit()) {
      const editToggle = el("button", { class: "link-btn", text: "Edit meeting" });
      const editWrap = el("div", { class: "hidden" });
      editToggle.addEventListener("click", async () => {
        editWrap.classList.toggle("hidden");
        if (editWrap.children.length === 0) {
          const roster = await api("/users");
          editWrap.appendChild(renderMeetingForm(m, roster, onChanged, () => {
            editWrap.innerHTML = "";
            editWrap.classList.add("hidden");
          }));
        }
      });
      body.appendChild(editToggle);
      body.appendChild(editWrap);
      body.appendChild(renderAccessHistorySection(`/meetings/${m.id}/logs`));
    }
  });

  return card;
}


async function renderDashboard(user, org) {
  if (_presencePollInterval) { clearInterval(_presencePollInterval); _presencePollInterval = null; }
  currentUser = user;
  currentOrg = org;
  setHeader(user, org);
  main.innerHTML = "";

  const showList = () => renderDashboard(currentUser, currentOrg);
  const showDetail = (identityId) => renderPersonDetail(identityId, showList);

  const recipientListBtn = el("button", { class: "secondary", text: "Recipient List" });
  recipientListBtn.addEventListener("click", () => renderRecipientListPage(showDetail, showList));
  const requestsVotesBtn = el("button", { class: "secondary", text: "Requests & Votes" });
  requestsVotesBtn.addEventListener("click", () => renderRequestsAndVotesPage(showDetail, showList));
  const overviewBtn = el("button", { class: "secondary", text: "Overview" });
  overviewBtn.addEventListener("click", () => renderOverviewReportPage(showList));
  const meetingsBtn = el("button", { class: "secondary", text: "Meetings" });
  meetingsBtn.addEventListener("click", () => renderMeetingsPage(showList));
  main.appendChild(el("div", { class: "button-row nav-row" }, [recipientListBtn, requestsVotesBtn, overviewBtn, meetingsBtn]));

  const myInfoFor = (label) => renderMyInfoSection(async () => {
    const updated = await api("/auth/me");
    setHeader(updated, currentOrg);
  });

  if (user.role === "admin") {
    const newPersonBtn = el("button", { class: "secondary", text: "+ New recipient" });
    newPersonBtn.addEventListener("click", () => renderNewPersonPage((newIdentityId) => showDetail(newIdentityId), showList));
    const accessLogsBtn = el("button", { class: "secondary", text: "Access Logs" });
    accessLogsBtn.addEventListener("click", () => renderAccessLogsPage(showDetail, showList));
    const checkRegisterBtn = el("button", { class: "secondary", text: "Check Register" });
    checkRegisterBtn.addEventListener("click", () => renderCheckRegisterPage(showDetail, showList));
    const manageTeam = await renderManageTeamSection();
    const myInfo = await myInfoFor();

    const section = el("section");
    section.appendChild(el("div", { class: "button-row nav-row" }, [newPersonBtn, manageTeam.toggle, accessLogsBtn, checkRegisterBtn, myInfo.toggle]));
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
    section.appendChild(el("div", { class: "button-row nav-row" }, [newPersonBtn, directory.toggle, myInfo.toggle]));
    section.appendChild(directory.body);
    section.appendChild(myInfo.body);
    main.appendChild(section);
  }
  if (user.role === "volunteer") {
    const myInfo = await myInfoFor();
    const section = el("section");
    section.appendChild(el("div", { class: "button-row nav-row" }, [myInfo.toggle]));
    section.appendChild(myInfo.body);
    main.appendChild(section);
  }
  if (user.role === "financial_secretary") {
    const newPersonBtn = el("button", { class: "secondary", text: "+ New recipient" });
    newPersonBtn.addEventListener("click", () => renderFinancialSecretaryIntakeFlow(showList));
    const checkRegisterBtn = el("button", { class: "secondary", text: "Check Register" });
    checkRegisterBtn.addEventListener("click", () => renderCheckRegisterPage(showDetail, showList));
    const directory = await renderTeamDirectorySection();
    const myInfo = await myInfoFor();
    const section = el("section");
    section.appendChild(el("div", { class: "button-row nav-row" }, [newPersonBtn, checkRegisterBtn, directory.toggle, myInfo.toggle]));
    section.appendChild(directory.body);
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

let _globalPresenceStarted = false;

function showReportIssueForm() {
  const overlay = el("div", { class: "file-popup-overlay" });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const closeBtn = el("button", { class: "secondary", text: "Close" });
  closeBtn.addEventListener("click", () => overlay.remove());

  const panel = el("div", { class: "file-popup-panel" });
  panel.appendChild(el("div", { class: "file-popup-header" }, [el("span", { text: "Report an issue" }), closeBtn]));

  const feedback = el("div");
  const titleInput = el("input", { type: "text", required: "true", placeholder: "Short summary" });
  const descInput = el("textarea", { placeholder: "What happened? What did you expect instead?" });
  const submitBtn = el("button", { class: "primary", text: "Submit" });

  const form = el("form", { onsubmit: async (e) => {
    e.preventDefault();
    submitBtn.setAttribute("disabled", "true");
    feedback.innerHTML = "";
    try {
      const result = await api("/feedback", {
        method: "POST",
        body: JSON.stringify({
          title: titleInput.value,
          description: descInput.value,
          page_context: document.title,
        }),
      });
      feedback.appendChild(msg("Thanks \u2014 issue created.", "success"));
      form.reset();
    } catch (err) {
      feedback.appendChild(msg(err.message, "error"));
    } finally {
      submitBtn.removeAttribute("disabled");
    }
  }});

  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Summary" }), titleInput]));
  form.appendChild(el("div", { class: "field" }, [el("label", { text: "Details" }), descInput]));
  form.appendChild(submitBtn);

  const issuesToggle = el("button", { class: "link-btn", text: "View all issues" });
  const issuesBody = el("div", { class: "hidden" });
  let issuesPage = 1;

  async function loadIssuesPage() {
    issuesBody.innerHTML = "";
    try {
      const data = await api(`/feedback/issues?page=${issuesPage}`);
      if (data.issues.length === 0) {
        issuesBody.appendChild(el("div", { class: "empty-state", text: issuesPage === 1 ? "No issues yet." : "No more issues." }));
      } else {
        const list = el("div", { class: "ledger" });
        for (const iss of data.issues) {
          list.appendChild(el("div", { class: "ledger-row" }, [
            el("span", { class: "date", text: formatDateDisplay(iss.created_at.slice(0, 10)) }),
            el("span", { class: "category", text: `#${iss.number} \u2014 ${iss.title}` }),
            el("span", { class: "amount", text: iss.state === "open" ? "Open" : "Closed" }),
          ]));
        }
        issuesBody.appendChild(list);
      }

      const pagerRow = el("div", { class: "button-row" });
      const prevBtn = el("button", { class: "secondary", text: "\u2190 Previous" });
      const nextBtn = el("button", { class: "secondary", text: "Next \u2192" });
      if (issuesPage <= 1) prevBtn.setAttribute("disabled", "true");
      if (!data.has_more) nextBtn.setAttribute("disabled", "true");
      prevBtn.addEventListener("click", () => { issuesPage--; loadIssuesPage(); });
      nextBtn.addEventListener("click", () => { issuesPage++; loadIssuesPage(); });
      pagerRow.appendChild(prevBtn);
      pagerRow.appendChild(nextBtn);
      issuesBody.appendChild(pagerRow);
    } catch (err) {
      issuesBody.appendChild(msg(err.message, "error"));
    }
  }

  issuesToggle.addEventListener("click", () => {
    const nowHidden = issuesBody.classList.toggle("hidden");
    issuesToggle.textContent = nowHidden ? "View all issues" : "Hide issues";
    if (!nowHidden) loadIssuesPage();
  });

  const body = el("div");
  body.style.padding = "16px";
  body.appendChild(form);
  body.appendChild(feedback);
  body.appendChild(el("hr"));
  body.appendChild(issuesToggle);
  body.appendChild(issuesBody);
  panel.appendChild(body);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function startGlobalPresence() {
  if (_globalPresenceStarted) return;
  _globalPresenceStarted = true;

  const headerUser = document.querySelector(".header-user");
  const signOutBtn = document.getElementById("sign-out-btn");
  const reportBtn = el("button", { class: "link-btn", text: "Report an issue" });
  headerUser.insertBefore(reportBtn, signOutBtn);
  reportBtn.addEventListener("click", () => showReportIssueForm());

  const onlineToggle = el("button", { class: "link-btn", text: "" });
  const onlineDropdown = el("div", { class: "hidden online-dropdown" });
  headerUser.insertBefore(onlineDropdown, signOutBtn);
  headerUser.insertBefore(onlineToggle, onlineDropdown);

  onlineToggle.addEventListener("click", () => onlineDropdown.classList.toggle("hidden"));

  let knownServerStartedAt = null;
  let updateBannerShown = false;

  function showUpdateBanner() {
    if (updateBannerShown) return;
    updateBannerShown = true;
    const banner = el("div", { class: "update-banner" });
    banner.appendChild(el("span", { text: "A new version of this app is available." }));
    const refreshBtn = el("button", { class: "secondary", text: "Refresh now" });
    refreshBtn.addEventListener("click", () => window.location.reload());
    banner.appendChild(refreshBtn);
    document.body.appendChild(banner);
  }

  async function tick() {
    try {
      const data = await api("/auth/heartbeat", { method: "POST" });
      const others = data.others_online;
      onlineToggle.textContent = `${others.length + 1} online`;
      onlineDropdown.innerHTML = "";
      if (others.length === 0) {
        onlineDropdown.appendChild(el("div", { class: "lead", text: "Just you right now." }));
      }
      for (const o of others) {
        onlineDropdown.appendChild(el("div", { class: "lead", text: `${o.name} (${o.role})` }));
      }

      if (knownServerStartedAt === null) {
        knownServerStartedAt = data.server_started_at;
      } else if (data.server_started_at !== knownServerStartedAt) {
        // The server process has restarted since this page loaded —
        // new code is running. Never auto-reload, since that could
        // wipe out something someone's in the middle of typing —
        // just let them know, on their own terms.
        showUpdateBanner();
      }
    } catch (e) {
      // Best-effort — never disrupt the app over a failed heartbeat.
    }
  }
  tick();
  setInterval(tick, 30000);
}

const DEV_THEME_OVERRIDE = {
  "--brass": "#5C8770",
  "--brass-deep": "#3E6350",
  "--paper": "#E8EDE8",
  "--paper-raised": "#F0F5F0",
  "--line": "#C9D4C9",
};

function applyEnvironmentTheme(org) {
  if (org.environment === "development") {
    for (const [key, value] of Object.entries(DEV_THEME_OVERRIDE)) {
      document.documentElement.style.setProperty(key, value);
    }
  }
}

async function boot() {
  const org = await loadOrgSettings();
  document.title = siteDisplayName(org);
  applyEnvironmentTheme(org);
  try {
    const user = await api("/auth/me");
    if (user.needs_setup) {
      renderAccountSetup(user, org, () => boot());
    } else {
      startGlobalPresence();
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
