(() => {
  "use strict";

  const PROFILE_KEY = "riwaq-profile-v1";
  const gate = document.getElementById("authGate");
  const app = document.querySelector(".app-shell");
  const config = window.RIWAQ_AUTH_CONFIG || {};
  const configured = Boolean(config.supabaseUrl && config.anonKey);
  let client = null;
  let session = null;
  let profile = readProfile();
  let method = "email";
  let otpPending = null;
  let chosenGrade = String(profile?.grade || "11");
  let busy = false;

  function readProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null"); }
    catch { return null; }
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function setStatus(message, error = true) {
    const node = gate.querySelector(".auth-status");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("error", error && Boolean(message));
  }
  function activateApp() {
    window.RIWAQ_PROFILE = profile || {};
    gate.innerHTML = "";
    gate.hidden = true;
    app.hidden = false;
    document.body.classList.add("auth-ready");
  }
  function setupNote() {
    return configured
      ? "اختر البريد أو الهاتف لتصلك رسالة برمز مؤقت. لا تشارك الرمز مع أحد."
      : "تسجيل Google والرموز يحتاج ربط مشروع مصادقة. أدخل إعدادات Supabase العامة في data/auth-config.js ثم فعّل مزوّدي البريد وGoogle والهاتف في لوحة المشروع. لا تضع مفتاح الخدمة السري هناك.";
  }
  function renderLogin() {
    document.body.classList.remove("auth-ready");
    gate.hidden = false;
    app.hidden = true;
    const isEmail = method === "email";
    const subject = otpPending ? "أدخل رمز التحقق" : "ادخل إلى مساحتك الدراسية";
    const intro = otpPending
      ? `أرسلنا رمزًا إلى ${escapeHtml(otpPending.value)}. أدخله للمتابعة.`
      : "اختر طريقة الدخول، ثم اكتب اسمك وصفك لتظهر لك موادك.";
    const methodFields = isEmail
      ? `<div class="auth-field"><label for="authEmail">البريد الإلكتروني</label><input id="authEmail" name="email" type="email" autocomplete="email" required placeholder="name@example.com" value="${escapeHtml(otpPending?.method === "email" ? otpPending.value : "")}"></div>`
      : `<div class="auth-field"><label for="authPhone">رقم الهاتف مع رمز الدولة</label><input id="authPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="+968 9xxxxxxx" value="${escapeHtml(otpPending?.method === "phone" ? otpPending.value : "")}"><small>اكتب الرقم بالصيغة الدولية، مثل ‎+968…</small></div><div class="auth-channel"><label><input type="radio" name="channel" value="sms" checked> رسالة نصية SMS</label><label><input type="radio" name="channel" value="whatsapp"> واتساب</label></div>`;
    gate.innerHTML = `<div class="auth-wrap"><div class="auth-brand"><span class="auth-brand-mark">ر</span><span><b>رِواق</b><small>مساحة تعلّمك في عُمان</small></span></div><section class="auth-card"><div class="auth-kicker">تعلّم على خطّتك</div><h1>${subject}</h1><p class="auth-intro">${intro}</p><button class="auth-provider" type="button" data-auth="google"><span class="google-mark">G</span>المتابعة باستخدام Google</button><div class="auth-divider">أو استخدم رمزًا لمرة واحدة</div><div class="auth-tabs"><button class="auth-tab ${isEmail ? "active" : ""}" type="button" data-method="email">البريد الإلكتروني</button><button class="auth-tab ${!isEmail ? "active" : ""}" type="button" data-method="phone">رقم الهاتف</button></div><form id="authForm">${methodFields}${otpPending ? `<div class="auth-field"><label for="authCode">رمز التحقق</label><input id="authCode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required placeholder="اكتب الرمز الذي وصلك"></div>` : ""}<button class="auth-submit" type="submit" ${busy ? "disabled" : ""}>${busy ? "جارٍ الإرسال…" : otpPending ? "تحقق وتابع" : "أرسل رمز الدخول"}</button></form><p class="auth-status" role="status"></p><p class="auth-note">${setupNote()}</p><button class="auth-local" type="button" data-auth="local">التصفح دون حساب — يُحفظ التقدم على هذا الجهاز فقط</button></section></div>`;
    gate.querySelectorAll("[data-method]").forEach(button => button.addEventListener("click", () => { method = button.dataset.method; otpPending = null; renderLogin(); }));
    gate.querySelector("[data-auth=google]").addEventListener("click", signInGoogle);
    gate.querySelector("[data-auth=local]").addEventListener("click", () => { profile = { name: "", grade: "11", mode: "local" }; chosenGrade = "11"; renderProfile(false); });
    gate.querySelector("#authForm").addEventListener("submit", handleOtpSubmit);
  }
  function renderProfile(switching = false) {
    document.body.classList.remove("auth-ready");
    gate.hidden = false;
    app.hidden = true;
    const name = escapeHtml(profile?.name || "");
    const descriptions = {
      "10": "كتب الصف العاشر المرفقة في هذه المنصة",
      "11": "محتوى الصف الحادي عشر الموجود في المنصة",
      "12": "يمكن اختيار الصف؛ كتب الصف الثاني عشر لم تُرفق بعد"
    };
    gate.innerHTML = `<div class="auth-wrap"><div class="auth-brand"><span class="auth-brand-mark">ر</span><span><b>رِواق</b><small>خطوة أخيرة قبل بدء الدراسة</small></span></div><section class="auth-card"><div class="auth-kicker">ملف الطالب</div><h1>${switching ? "تعديل الصف والاسم" : "عرّفنا بك"}</h1><p class="auth-intro">سيُستخدم الاسم للترحيب بك. اختر صفك لعرض خريطة مواده.</p><div class="auth-field"><label for="profileName">اسم الطالب</label><input id="profileName" maxlength="32" autocomplete="name" value="${name}" placeholder="اكتب اسمك" required></div><div class="auth-choices" role="group" aria-label="اختيار الصف">${["10", "11", "12"].map((grade, index) => `<button type="button" class="auth-grade ${chosenGrade === grade ? "selected" : ""}" data-grade="${grade}" aria-pressed="${chosenGrade === grade}"><span class="auth-grade-mark">${["١٠", "١١", "١٢"][index]}</span><span><b>الصف ${["العاشر", "الحادي عشر", "الثاني عشر"][index]}</b><small>${descriptions[grade]}</small></span></button>`).join("")}</div><p class="auth-status" role="status"></p><button class="auth-primary" type="button" data-auth="save-profile">${switching ? "حفظ التغييرات" : "ابدأ التعلّم"}</button><button class="auth-back" type="button" data-auth="back">${session ? "تسجيل الخروج" : switching ? "إلغاء" : "العودة إلى الدخول"}</button></section></div>`;
    gate.querySelectorAll("[data-grade]").forEach(button => button.addEventListener("click", () => {
      chosenGrade = button.dataset.grade;
      gate.querySelectorAll("[data-grade]").forEach(item => { item.classList.toggle("selected", item === button); item.setAttribute("aria-pressed", String(item === button)); });
      setStatus(chosenGrade === "12" ? "لم تُرفق كتب الصف الثاني عشر بعد؛ اختر الصف العاشر أو الحادي عشر لعرض محتوى جاهز." : "", false);
    }));
    gate.querySelector("[data-auth=save-profile]").addEventListener("click", () => saveProfile(switching));
    gate.querySelector("[data-auth=back]").addEventListener("click", () => {
      if (session) signOut();
      else if (switching) activateApp();
      else renderLogin();
    });
  }
  async function loadClient() {
    if (client) return client;
    if (!configured) throw new Error("لم تُربط خدمة المصادقة بعد.");
    if (!window.supabase?.createClient) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
        script.onload = resolve;
        script.onerror = () => reject(new Error("تعذّر تحميل مكتبة المصادقة. تحقق من الاتصال بالإنترنت."));
        document.head.append(script);
      });
    }
    client = window.supabase.createClient(config.supabaseUrl, config.anonKey);
    client.auth.onAuthStateChange((event, nextSession) => {
      session = nextSession;
      if (event === "SIGNED_IN" && session && !profile?.grade) renderProfile(false);
      if (event === "SIGNED_OUT") { profile = null; localStorage.removeItem(PROFILE_KEY); renderLogin(); }
    });
    return client;
  }
  async function signInGoogle() {
    if (busy) return;
    try {
      const auth = await loadClient();
      busy = true; setStatus("جارٍ فتح تسجيل Google…", false);
      const { error } = await auth.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href } });
      if (error) throw error;
    } catch (error) { setStatus(error.message || "تعذّر بدء تسجيل Google."); busy = false; }
  }
  async function handleOtpSubmit(event) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    busy = true;
    const submit = gate.querySelector(".auth-submit");
    if (submit) { submit.disabled = true; submit.textContent = otpPending ? "جارٍ التحقق…" : "جارٍ إرسال الرمز…"; }
    try {
      const auth = await loadClient();
      if (!otpPending && method === "email") {
        const email = String(values.get("email") || "").trim();
        const { error } = await auth.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
        if (error) throw error;
        otpPending = { method: "email", value: email };
      } else if (!otpPending && method === "phone") {
        const phone = String(values.get("phone") || "").replace(/[\s()-]/g, "");
        if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("اكتب الرقم بالصيغة الدولية مع + ورمز الدولة.");
        const channel = String(values.get("channel") || "sms");
        const { error } = await auth.auth.signInWithOtp({ phone, options: { channel } });
        if (error) throw error;
        otpPending = { method: "phone", value: phone, channel };
      } else {
        const token = String(values.get("code") || "").trim();
        const input = otpPending.method === "email" ? { email: otpPending.value, token, type: "email" } : { phone: otpPending.value, token, type: "sms" };
        const { data, error } = await auth.auth.verifyOtp(input);
        if (error) throw error;
        session = data.session;
        profile = { name: "", grade: "11", mode: "account" };
        chosenGrade = "11";
        otpPending = null;
        busy = false;
        renderProfile(false);
        return;
      }
      busy = false;
      renderLogin();
      setStatus("أُرسل الرمز. افحص بريدك أو هاتفك ثم أدخله هنا.", false);
    } catch (error) {
      busy = false;
      if (submit) submit.disabled = false;
      setStatus(error.message || "تعذّر إرسال رمز الدخول.");
    }
  }
  function saveProfile(switching) {
    const name = String(gate.querySelector("#profileName")?.value || "").trim();
    if (!name) { setStatus("اكتب اسمك أولًا."); gate.querySelector("#profileName")?.focus(); return; }
    profile = { name, grade: chosenGrade, mode: session ? "account" : "local" };
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); }
    catch { setStatus("تعذّر حفظ ملف الطالب في هذا المتصفح."); return; }
    window.RIWAQ_PROFILE = profile;
    window.location.reload();
  }
  async function signOut() {
    try { if (client && session) await client.auth.signOut(); }
    catch { /* The local profile is still removed below. */ }
    localStorage.removeItem(PROFILE_KEY);
    window.location.reload();
  }
  function showProfileSwitcher() {
    profile = readProfile() || { name: "", grade: "11", mode: "local" };
    chosenGrade = String(profile.grade || "11");
    renderProfile(true);
  }
  async function init() {
    app.hidden = true;
    const stored = readProfile();
    profile = stored;
    if (stored?.mode === "local" && stored.name && stored.grade) {
      activateApp();
      return;
    }
    if (configured) {
      try {
        const auth = await loadClient();
        const { data, error } = await auth.auth.getSession();
        if (error) throw error;
        session = data.session;
        if (session && stored?.mode === "account" && stored.grade) activateApp();
        else if (session) { profile = { name: stored?.name || "", grade: stored?.grade || "11", mode: "account" }; chosenGrade = profile.grade; renderProfile(false); }
        else renderLogin();
      } catch (error) { renderLogin(); setStatus(error.message || "تعذّر التحقق من جلسة الدخول."); }
    } else {
      renderLogin();
    }
  }
  window.RIWAQ_AUTH = { signOut, showProfileSwitcher };
  init();
})();
