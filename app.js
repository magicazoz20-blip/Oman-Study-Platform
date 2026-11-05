(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const savedProfile = window.RIWAQ_PROFILE || (() => { try { return JSON.parse(localStorage.getItem("riwaq-profile-v1") || "null"); } catch { return null; } })();
  const selectedGrade = String(savedProfile?.grade || "11");
  const gradeNames = { "10": "العاشر", "11": "الحادي عشر", "12": "الثاني عشر" };
  const STORAGE_KEY = `riwaq-grade${selectedGrade}-v1`;
  const DB_NAME = "riwaq-local-books";
  const DB_STORE = "books";
  const curriculumByGrade = { "10": window.CURRICULUM_G10 || [], "11": window.CURRICULUM || [], "12": window.CURRICULUM_G12 || [] };
  const curriculum = curriculumByGrade[selectedGrade] || [];
  const questions = selectedGrade === "10" ? (window.QUESTION_BANK_G10 || []) : (selectedGrade === "11" ? (window.QUESTION_BANK || []) : []);
  const terms = selectedGrade === "10" ? (window.STUDY_TERMS_G10 || []) : (window.STUDY_TERMS || []);
  const lessonGuides = selectedGrade === "10" ? (window.LESSON_GUIDES_G10 || {}) : (window.LESSON_GUIDES || {});
  const unitGuides = selectedGrade === "10" ? (window.UNIT_GUIDES_G10 || {}) : (window.UNIT_GUIDES || {});
  const examWeights = selectedGrade === "10" ? (window.EXAM_WEIGHTS_G10 || {}) : (window.EXAM_WEIGHTS || {});
  const examSpecs = selectedGrade === "10" ? (window.EXAM_SPECS_G10 || {}) : (window.EXAM_SPECS || {});
  const courseById = new Map(curriculum.map(item => [item.id, item]));
  const unitById = new Map(curriculum.flatMap(subject => subject.units.map(unit => [unit.id, { ...unit, subjectId: subject.id, subjectName: subject.name }])));
  const lessonById = new Map();
  for (const subject of curriculum) for (const unit of subject.units) for (const raw of unit.lessons) {
    const lesson = { id: `${unit.id}-l${lessonById.size + 1}`, code: raw[0], title: raw[1], page: raw[2], subjectId: subject.id, subjectName: subject.name, unitId: unit.id, unitTitle: unit.title };
    lessonById.set(lesson.id, lesson);
  }

  const subjectLessons = subjectId => [...lessonById.values()].filter(item => item.subjectId === subjectId);
  const allUnits = subjectId => subjectId ? curriculum.find(item => item.id === subjectId)?.units || [] : curriculum.flatMap(item => item.units);
  const defaultState = () => ({
    name: savedProfile?.name || "", theme: "light", examDate: "", completed: [], favorites: [], recent: [], attempts: [], mistakes: [],
    tasks: [], schedule: {}, bookMeta: {}, reminder: true
  });
  let state = loadState();
  let activePage = "dashboard";
  let selectedSubject = null;
  let selectedUnit = null;
  let selectedLesson = null;
  let lessonTab = "study";
  let subjectFilter = "all";
  let flashIndex = 0;
  let flashFlipped = false;
  let quizState = null;
  let assessmentState = null;
  let attachedBookSubject = null;
  const activePdfUrls = new Map();
  let dbPromise = null;

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return { ...defaultState(), ...(parsed || {}) };
    } catch { return defaultState(); }
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { toast("تعذّر حفظ بعض التغييرات في هذا المتصفح."); }
    updateSidebarProgress();
    updateNotificationDot();
  }
  function syncProfileName(name) {
    try {
      const profile = JSON.parse(localStorage.getItem("riwaq-profile-v1") || "null");
      if (!profile) return;
      profile.name = name;
      localStorage.setItem("riwaq-profile-v1", JSON.stringify(profile));
      window.RIWAQ_PROFILE = profile;
    } catch { /* The study workspace remains usable if profile storage is unavailable. */ }
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }
  function pct(done, total) { return total ? Math.round(done / total * 100) : 0; }
  function totalLessons(subjectId = null) { return subjectLessons(subjectId || "").length || (subjectId ? subjectLessons(subjectId).length : lessonById.size); }
  function completedCount(subjectId = null) { return state.completed.filter(id => lessonById.get(id)?.subjectId === subjectId || !subjectId && lessonById.has(id)).length; }
  function progressFor(subjectId = null) { return pct(completedCount(subjectId), totalLessons(subjectId)); }
  function subjectIcon(subjectId) { return courseById.get(subjectId)?.icon || "▦"; }
  function guideFor(lesson) { return lesson ? lessonGuides[lesson.unitId + "|" + lesson.code] || null : null; }
  function unitWeight(subjectId, unitId) {
    const plan = examWeights[subjectId];
    const unit = plan && plan.units.find(row => row[0] === unitId);
    return unit ? { plan: plan, marks: unit[1], percent: unit[2] } : null;
  }
  function renderExamWeights(subject) {
    const plan = examWeights[subject.id];
    if (!plan) {
      const spec = examSpecs[subject.id];
      if (!spec) return "<section class=\"card card-pad weight-card\"><div class=\"section-head\" style=\"margin:0\"><div><h2>توزيع درجات الامتحان</h2><p>لا يتوفر هنا جدول وزاري موثوق لهذه المادة؛ لم نضع أرقامًا تقديرية.</p></div></div></section>";
      return "<section class=\"card card-pad weight-card\"><div class=\"section-head\" style=\"margin:0 0 10px\"><div><h2>مواصفات امتحان نهاية الفصل</h2><p>الدرجة " + spec.total + " · الزمن " + escapeHtml(spec.duration) + " · وثيقة " + escapeHtml(spec.year) + "</p></div><a class=\"text-link\" target=\"_blank\" rel=\"noopener noreferrer\" href=\"" + escapeHtml(spec.source) + "\">وثيقة الوزارة ↗</a></div><div class=\"exam-spec-pills\"><span>أسئلة موضوعية " + spec.objectivePercent + "٪</span><span>أسئلة مقالية " + spec.writtenPercent + "٪</span></div><p class=\"weight-caveat\">" + escapeHtml(spec.note) + "</p></section>";
    }
    const rows = plan.units.map(row => {
      const unit = unitById.get(row[0]);
      return "<tr><td>" + escapeHtml(unit ? unit.title : row[0]) + "</td><td>" + row[1] + " من " + plan.total + "</td><td>" + row[2] + "٪</td></tr>";
    }).join("");
    return "<section class=\"card card-pad weight-card\"><div class=\"section-head\" style=\"margin:0 0 10px\"><div><h2>توزيع درجات الامتحان النهائي</h2><p>" + escapeHtml(plan.semester) + " · الدرجة الكلية " + plan.total + " · إصدار " + escapeHtml(plan.year) + "</p></div><a class=\"text-link\" target=\"_blank\" rel=\"noopener noreferrer\" href=\"" + escapeHtml(plan.source) + "\">وثيقة الوزارة ↗</a></div><div class=\"table-scroll\"><table class=\"weight-table\"><thead><tr><th>الوحدة</th><th>الدرجات</th><th>الوزن النسبي</th></tr></thead><tbody>" + rows + "</tbody><tfoot><tr><th>المجموع</th><th>" + plan.total + "</th><th>١٠٠٪</th></tr></tfoot></table></div><p class=\"weight-caveat\">يعرض هذا الجدول السنة المذكورة في المصدر. توزيع العام الحالي قد يتغير؛ اتبع نشرة مدرستك إذا صدرت نسخة أحدث.</p></section>";
  }
  function shortDate(date = new Date()) {
    return new Intl.DateTimeFormat("ar-OM", { weekday: "long", day: "numeric", month: "long" }).format(date);
  }
  function navTo(page) {
    if (quizState?.timerId) clearInterval(quizState.timerId);
    activePage = page;
    selectedSubject = selectedUnit = selectedLesson = null;
    quizState = null;
    assessmentState = null;
    $$(".nav-item[data-nav]").forEach(button => button.classList.toggle("active", button.dataset.nav === page));
    renderPage();
    closeSidebar();
  }
  function setCrumb(value) { $("#pageCrumb").textContent = value; }
  function renderPage() {
    const host = $("#pageContent");
    host.innerHTML = "";
    host.dataset.page = activePage;
    if (!curriculum.length) {
      setCrumb("المحتوى الدراسي");
      host.innerHTML = `<section class="card card-pad"><div class="eyebrow">الصف ${gradeNames[selectedGrade] || "المختار"}</div><h1>كتب هذا الصف غير متاحة في المنصة بعد</h1><p>لم تُرفق كتب الصف الثاني عشر في هذه المحادثة، لذلك لا أعرض دروسًا أو درجات غير موثقة. أضف كتب الصف من الإعدادات عند توفرها، أو غيّر الصف إلى العاشر أو الحادي عشر.</p><div class="heading-actions"><button class="btn primary" data-action="change-grade">اختيار صف آخر</button><button class="btn" data-action="sign-out">تسجيل الخروج</button></div></section>`;
      $("#studentName").textContent = state.name || `طالب الصف ${gradeNames[selectedGrade] || ""}`;
      $(".avatar").textContent = [...(state.name || "ط")][0] || "ط";
      $("#gradeFooter").textContent = `سلطنة عُمان · الصف ${gradeNames[selectedGrade] || ""}`;
      $("#navSubjectCount").textContent = "0";
      return;
    }
    const renderers = {
      dashboard: renderDashboard, subjects: renderSubjects, revision: renderRevision, exams: renderExams,
      flashcards: renderFlashcards, planner: renderPlanner, assistant: renderAssistant, resources: renderResources, settings: renderSettings
    };
    (renderers[activePage] || renderDashboard)();
    if (activePage === "settings") renderAccountControls();
    $("#navSubjectCount").textContent = String(curriculum.length);
    const nameInput = $("#studentNameInput");
    if (nameInput) nameInput.placeholder = `طالب الصف ${gradeNames[selectedGrade] || ""}`;
    $("#studentName").textContent = state.name || `طالب الصف ${gradeNames[selectedGrade] || ""}`;
    $(".avatar").textContent = [...(state.name || "طالب")][0] || "ط";
    $("#gradeFooter").textContent = `سلطنة عُمان · الصف ${gradeNames[selectedGrade] || ""}`;
    document.title = `رِواق | الصف ${gradeNames[selectedGrade] || ""}`;
    updateSidebarProgress();
    updateNotificationDot();
  }
  function renderAccountControls() {
    const grid = $(".settings-grid");
    if (!grid) return;
    const card = document.createElement("section");
    card.className = "card settings-panel account-settings-card";
    card.innerHTML = `<h2>الحساب والصف</h2><p>الصف الحالي: <b>الصف ${gradeNames[selectedGrade] || ""}</b></p><p class="muted">الحساب ${savedProfile?.mode === "account" ? "مرتبط بمزوّد تسجيل الدخول" : "محلي على هذا الجهاز"}.</p><div class="heading-actions"><button class="btn" data-action="change-grade">تغيير الصف</button><button class="btn danger" data-action="sign-out">تسجيل الخروج</button></div>`;
    grid.after(card);
  }
  function updateSidebarProgress() {
    const percent = progressFor();
    const label = $("#sideProgressText");
    const bar = $("#sideProgressBar");
    if (label) label.textContent = `${percent}٪`;
    if (bar) bar.style.width = `${percent}%`;
    const mistakeCount = $("#navMistakeCount");
    if (mistakeCount) mistakeCount.textContent = state.mistakes.length;
  }
  function updateNotificationDot() {
    const today = new Date().toISOString().slice(0, 10);
    const hasDue = state.tasks.some(task => !task.done && (!task.due || task.due <= today));
    $("#notificationDot")?.classList.toggle("show", !!state.reminder && hasDue);
  }
  function toast(message) {
    const stack = $("#toastStack");
    const item = document.createElement("div");
    item.className = "toast";
    item.textContent = message;
    stack.append(item);
    setTimeout(() => item.remove(), 3000);
  }
  function iconColor(subject) { return `style="--subject-color:${subject.color}"`; }

  function renderDashboard() {
    setCrumb("الرئيسية");
    const name = state.name ? `أهلًا ${escapeHtml(state.name)}` : "أهلًا بك في رِواق";
    const total = lessonById.size;
    const done = completedCount();
    const recent = state.recent.map(id => lessonById.get(id)).filter(Boolean).slice(0, 3);
    const taskPreview = state.tasks.filter(item => !item.done).slice(0, 3);
    const subjectCards = curriculum.map(subject => subjectCard(subject, true)).join("");
    const week = renderWeekStrip(false);
    const deadline = renderDeadline();
    const progressItems = curriculum.filter(subject => subjectLessons(subject.id).length).map(subject => `
      <div class="chart-line"><div class="chart-label"><span>${escapeHtml(subject.short)}</span><span>${progressFor(subject.id)}٪</span></div><div class="chart-track"><span style="width:${progressFor(subject.id)}%;background:${subject.color}"></span></div></div>`).join("");
    $("#pageContent").innerHTML = `
      <section class="dashboard-hero"><div class="hero-copy"><div class="hero-kicker"><span></span>${shortDate()}</div><h1>${name}</h1><p>خطوة هادئة كل يوم تصنع فرقًا كبيرًا. اختر مادة للمتابعة أو ابدأ مراجعة قصيرة.</p><div class="hero-buttons"><button class="btn hero-strong" data-action="open-subjects">ابدأ المذاكرة <span>←</span></button><button class="btn" data-action="start-random-quiz">اختبر نفسك</button></div></div><div class="hero-art" aria-hidden="true"><div class="study-orbit"><div class="orbit-ring"></div><div class="book-illustration"><span>✦</span></div><span class="float-note note-a">∑</span><span class="float-note note-b">✓</span></div></div></section>
      <section class="stats-grid">
        <div class="stat-card"><span class="stat-icon green">▦</span><div class="stat-meta"><b>${curriculum.length}</b><small>مواد في خريطة المصادر</small></div></div>
        <div class="stat-card"><span class="stat-icon gold">✓</span><div class="stat-meta"><b>${done}<small> / ${total}</small></b><small>دروس تمت مراجعتها</small></div></div>
        <div class="stat-card"><span class="stat-icon blue">◉</span><div class="stat-meta"><b>${state.attempts.length}</b><small>محاولات تدريب مسجلة</small></div></div>
        <div class="stat-card"><span class="stat-icon violet">☆</span><div class="stat-meta"><b>${state.favorites.length}</b><small>دروس محفوظة للمراجعة</small></div></div>
      </section>
      <div class="dashboard-columns"><div>
        <div class="section-head"><div><h2>موادك الدراسية</h2><p>اختر المادة للوصول إلى وحداتها ودروسها</p></div><button class="text-link" data-action="open-subjects">عرض الكل ←</button></div>
        <div class="subject-grid">${subjectCards}</div>
        <div class="section-head"><div><h2>خطة الأسبوع</h2><p>تظهر المواد التي تضيفها من خطتك الدراسية</p></div><button class="text-link" data-action="open-planner">تعديل الخطة ←</button></div>
        ${week}
      </div><aside class="dashboard-side">
        ${deadline}
        <section class="card continue-card"><div class="continue-art">${recent.length ? subjectIcon(recent[0].subjectId) : "✎"}</div><div class="continue-copy"><small>آخر ما فتحته</small>${recent.length ? `<b>${escapeHtml(recent[0].title)}</b><button class="text-link" data-action="open-lesson" data-id="${recent[0].id}">متابعة الدرس ←</button>` : `<b>ابدأ بأول درس لك</b><button class="text-link" data-action="open-subjects">اختر مادة ←</button>`}</div></section>
        <section class="card mini-progress-card"><div class="mini-progress-head"><h3>تقدّم المواد</h3><small>${done} من ${total} درس</small></div><div class="progress-chart">${progressItems}</div></section>
        <section class="card task-widget"><div class="task-widget-head"><h3>مهامك القادمة</h3><button class="text-link" data-action="open-planner">إدارة</button></div><div class="task-list">${taskPreview.length ? taskPreview.map(taskRow).join("") : `<div class="empty-note">لا توجد مهام مفتوحة.<br><button class="text-link" data-action="open-planner">أضف مهمة دراسية</button></div>`}</div></section>
      </aside></div>`;
  }

  function subjectCard(subject, compact = false) {
    const lessons = subjectLessons(subject.id).length;
    const unitCount = subject.units.length;
    const percent = progressFor(subject.id);
    const sourceLine = subject.unavailable ? `<span class="source-state">• لم يُستخرج محتوى من الملف المرفق</span>` : "";
    return `<button class="subject-card" ${iconColor(subject)} data-action="open-subject" data-id="${subject.id}"><span class="subject-top"><span class="subject-icon">${subject.icon}</span><span class="subject-arrow">←</span></span><h3>${escapeHtml(subject.name)}</h3><p>${unitCount ? `${unitCount} وحدات · ${lessons} درسًا` : "المرفق لا يحتوي على خريطة دروس مقروءة"}</p>${unitCount ? `<span class="subject-progress"><span class="progress-track"><span style="width:${percent}%"></span></span><small>${percent}٪</small></span>` : sourceLine}</button>`;
  }

  function renderSubjects() {
    setCrumb("المواد الدراسية");
    const groups = ["all", ...curriculum.map(item => item.id)];
    const labels = ["كل المواد", ...curriculum.map(item => item.short)];
    const pills = groups.map((key, index) => `<button class="filter-pill ${subjectFilter === key ? "active" : ""}" data-action="subject-filter" data-id="${key}">${labels[index]}</button>`).join("");
    const shown = subjectFilter === "all" ? curriculum : curriculum.filter(item => item.id === subjectFilter);
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">خريطة المنهج</div><h1>المواد الدراسية</h1><p>الوحدات والدروس المسجلة من الملفات المرفقة، مع توضيح أي مصدر تعذّر استخراجه.</p></div><div class="heading-actions"><button class="btn" data-action="open-settings">إدارة ملفات الكتب</button></div></div><div class="subject-toolbar">${pills}</div><div class="subject-grid">${shown.map(item => subjectCard(item)).join("")}</div><div class="exam-disclaimer" style="margin-top:16px">عدد الدروس الظاهر في هذه الخريطة مستخرج من فهارس الكتب المرفقة. يظهر ملف تقنية المعلومات كغير متاح لأن المرفق صفحة واحدة فارغة عند المعاينة.</div>`;
  }

  function renderSubject(subjectId) {
    const subject = courseById.get(subjectId);
    if (!subject) return renderSubjects();
    selectedSubject = subjectId;
    selectedUnit = selectedLesson = null;
    queueMicrotask(() => {
      if (activePage !== "subjects" || selectedSubject !== subjectId || !units.length) return;
      $("#pageContent .heading-actions")?.insertAdjacentHTML("afterbegin", "<button class=\"btn primary\" data-action=\"start-subject-final\" data-id=\"" + subjectId + "\">اختبار شامل للمادة</button>");
      $("#pageContent").insertAdjacentHTML("beforeend", renderExamWeights(subject));
    });
    setCrumb(subject.name);
    const units = subject.units;
    const unitCards = units.map(unit => {
      const unitLessonIds = [...lessonById.values()].filter(lesson => lesson.unitId === unit.id).map(lesson => lesson.id);
      const done = unitLessonIds.filter(id => state.completed.includes(id)).length;
      return `<section class="unit-card"><div class="unit-card-head"><span class="unit-number">${escapeHtml(unit.id.split("-u").pop())}</span><div><h3>${escapeHtml(unit.title)}</h3><small>${unit.lessons.length} موضوعًا${unit.pageRange ? ` · الصفحات ${unit.pageRange}` : ""}</small></div></div><div class="progress-track"><span style="width:${pct(done,unitLessonIds.length)}%"></span></div><div class="unit-card-foot"><span>${done} من ${unit.lessons.length} تمت مراجعتها</span><button data-action="open-unit" data-id="${unit.id}">افتح الوحدة ←</button></div></section>`;
    }).join("");
    const bookLoaded = state.bookMeta[subject.id];
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(subject.bookNote)}</div><h1>${escapeHtml(subject.name)}</h1><p>${units.length ? `${units.length} وحدات · ${subjectLessons(subjectId).length} درسًا من فهرس الكتاب` : "لم يُستخرج فهرس دراسي من الملف المرفق."}</p></div><div class="heading-actions"><button class="btn primary" data-action="attach-book" data-id="${subject.id}">${bookLoaded ? "فتح ملف الكتاب" : "إضافة ملف الكتاب"}</button><button class="btn" data-action="open-resources">المكتبة الرسمية</button></div></div>
      ${subject.unavailable ? `<section class="card card-pad"><div class="official-note">${escapeHtml(subject.verification)} أرفق نسخة واضحة من كتاب تقنية المعلومات من الإعدادات لإضافته إلى خريطة المواد.</div><button class="btn" style="margin-top:14px" data-action="attach-book" data-id="${subject.id}">اختيار نسخة PDF صحيحة</button></section>` : `<section class="card subject-detail-head" ${iconColor(subject)}><span class="subject-icon">${subject.icon}</span><div><h1>${escapeHtml(subject.name)}</h1><p>${escapeHtml(subject.bookNote)} · ${subject.bookPages} صفحة</p></div><div class="subject-detail-meta"><span class="meta-chip">${units.length} وحدات</span><span class="meta-chip">${subjectLessons(subject.id).length} درسًا</span><span class="meta-chip">${progressFor(subject.id)}٪ إنجاز</span></div></section>
      <div class="section-head"><div><h2>وحدات الكتاب</h2><p>تسلسل الوحدات بحسب فهرس الملف المرفق</p></div></div><div class="unit-grid">${unitCards}</div>
      <div class="section-head"><div><h2>مصدر المنهج</h2><p>${escapeHtml(subject.verification)}</p></div></div>${renderBookViewer(subject)}
      ${subject.id === "chem" ? renderChemVideos() : ""}`}`;
  }

  function renderUnit(subjectId, unitId) {
    const subject = courseById.get(subjectId);
    const unit = unitById.get(unitId);
    if (!subject || !unit) return renderSubject(subjectId);
    selectedSubject = subjectId;
    selectedUnit = unitId;
    selectedLesson = null;
    queueMicrotask(() => {
      if (selectedUnit !== unitId || activePage === "dashboard") return;
      const review = unitGuides[unitId];
      const weight = unitWeight(subjectId, unitId);
      const weightText = weight ? "<p class=\"unit-weight\">وزن الوحدة في امتحان الوزارة: <b>" + weight.marks + " من " + weight.plan.total + " درجة (" + weight.percent + "٪)</b> · " + escapeHtml(weight.plan.year) + "</p>" : "<p class=\"unit-weight\">لا يتوفر وزن رسمي موثوق لهذه الوحدة ضمن الوثائق المتاحة.</p>";
      if (review) $(".unit-overview")?.insertAdjacentHTML("afterend", "<section class=\"card unit-challenge\"><div><div class=\"eyebrow\">سؤال قصير على الوحدة</div><h3>" + escapeHtml(review.q) + "</h3><details><summary>اعرض إجابة نموذجية</summary><p>" + escapeHtml(review.a) + "</p></details>" + weightText + "</div><button class=\"btn primary\" data-action=\"start-unit-quiz\" data-id=\"" + unitId + "\">اختبار الوحدة</button></section>");
    });
    setCrumb(unit.title);
    const lessons = [...lessonById.values()].filter(lesson => lesson.unitId === unit.id);
    const lessonRows = lessons.map(lesson => `<button class="lesson-row" data-action="open-lesson" data-id="${lesson.id}"><span class="lesson-status ${state.completed.includes(lesson.id) ? "done" : ""}">${state.completed.includes(lesson.id) ? "✓" : "·"}</span><span class="lesson-name"><b>${escapeHtml(lesson.title)}</b><small>${escapeHtml(lesson.code)} · الصفحة المطبوعة ${lesson.page}</small></span><span class="lesson-open">←</span></button>`).join("");
    const focusTitles = lessons.slice(0, 3).map(lesson => `<li>${escapeHtml(lesson.title)}</li>`).join("");
    const bookLoaded = state.bookMeta[subject.id];
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(subject.name)} · الوحدة ${escapeHtml(unit.id.split("-u").pop())}</div><h1>${escapeHtml(unit.title)}</h1><p>${lessons.length} موضوعًا كما وردت في فهرس الكتاب.</p></div><div class="heading-actions"><button class="btn" data-action="back-subject" data-id="${subject.id}">العودة للمادة</button><button class="btn primary" data-action="start-unit-quiz" data-id="${unit.id}">اختبر الوحدة</button></div></div>
      <div class="unit-overview"><section class="card overview-panel"><h3>ملخص الوحدة من فهرس الكتاب</h3><p>تضم هذه الوحدة موضوعات متتابعة في <b>${escapeHtml(unit.title)}</b>. افتح كل موضوع في المصدر لقراءة الشرح والأمثلة والأنشطة كاملة، ثم سجّل مراجعتك هنا.</p><div class="official-note">أسماء الموضوعات وأرقام الصفحات من فهرس المصدر. لم يُعثر على توزيع رسمي مؤكد لدرجات هذه الوحدة.</div></section><section class="card overview-panel"><h3>أولويات المراجعة</h3><p>ابدأ حسب ترتيب المنهج، ثم عد إلى ما لم تضع عليه علامة المراجعة.</p><ul class="priority-list">${focusTitles}</ul></section></div>
      <section class="lesson-list">${lessonRows}</section>
      <div class="section-head"><div><h2>الكتاب المصدر</h2><p>يُقرأ من الملف المحلي الذي تختاره على جهازك</p></div></div>${bookLoaded ? renderBookViewer(subject, true) : `<div class="source-banner"><span class="source-banner-icon">▤</span><div><b>افتح شرح الوحدة الأصلي</b><small>اربط ملف الكتاب بهذه المادة مرة واحدة لعرضه هنا.</small></div><button class="btn small" data-action="attach-book" data-id="${subject.id}">إضافة PDF</button></div>`}`;
  }

  function renderLesson(subjectId, unitId, lessonId) {
    const subject = courseById.get(subjectId);
    const unit = unitById.get(unitId);
    const lesson = lessonById.get(lessonId);
    if (!subject || !unit || !lesson) return renderUnit(subjectId, unitId);
    selectedSubject = subjectId; selectedUnit = unitId; selectedLesson = lessonId;
    queueMicrotask(() => {
      if (selectedLesson !== lessonId) return;
      $("#pageContent .page-heading .heading-actions")?.insertAdjacentHTML("afterbegin", "<button class=\"btn primary\" data-action=\"start-lesson-test\" data-id=\"" + lessonId + "\">اختبار قصير للدرس</button>");
      const weight = unitWeight(subjectId, unitId);
      const weightNote = $(".article-aside .aside-card:last-child p");
      if (weightNote) weightNote.textContent = weight ? "الوحدة: " + weight.marks + " من " + weight.plan.total + " درجة (" + weight.percent + "٪) في وثيقة " + weight.plan.year + ". راجع جدول المادة لتفاصيل التوزيع." : "لا يتوفر توزيع رسمي موثوق لهذه الوحدة ضمن الوثائق المتاحة.";
      const tabNames = { study: "شرح الدرس", summary: "أهم ما أحفظ", questions: "تدريب واختبار" };
      $$(".article-tab").forEach(tab => { if (tabNames[tab.dataset.id]) tab.textContent = tabNames[tab.dataset.id]; });
    });
    setCrumb(lesson.title);
    if (!state.recent.includes(lessonId)) state.recent.unshift(lessonId);
    else state.recent = [lessonId, ...state.recent.filter(item => item !== lessonId)];
    state.recent = state.recent.slice(0, 8);
    saveState();
    const isFavorite = state.favorites.includes(lessonId);
    const isDone = state.completed.includes(lessonId);
    const matchingVideos = subjectId === "chem" ? (window.CHEMISTRY_VIDEOS || []).filter(video => video.title === lesson.title || lesson.title.includes(video.title) || video.title.includes(lesson.title)) : [];
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">${escapeHtml(subject.name)} · ${escapeHtml(unit.title)}</div><h1>${escapeHtml(lesson.title)}</h1><p>عنوان من فهرس الكتاب · الصفحة المطبوعة ${lesson.page}</p></div><div class="heading-actions"><button class="btn" data-action="back-unit" data-id="${unit.id}">الوحدة</button><button class="btn ${isFavorite ? "soft" : ""}" data-action="toggle-favorite" data-id="${lesson.id}">${isFavorite ? "★ محفوظ" : "☆ حفظ"}</button><button class="btn ${isDone ? "soft" : "primary"}" data-action="toggle-done" data-id="${lesson.id}">${isDone ? "✓ تمت المراجعة" : "تسجيل المراجعة"}</button></div></div>
      <div class="lesson-article"><div class="article-main"><section class="card article-title"><div><h1>${escapeHtml(lesson.title)}</h1><p>${escapeHtml(subject.name)} / ${escapeHtml(unit.title)} / ${escapeHtml(lesson.code)}</p></div><div class="article-actions"><button class="btn small" data-action="print-lesson" data-id="${lesson.id}">طباعة ورقة المراجعة</button></div></section>
      <nav class="article-tabs" aria-label="أقسام الدرس"><button class="article-tab ${lessonTab === "study" ? "active" : ""}" data-action="lesson-tab" data-id="study">خطة الدرس</button><button class="article-tab ${lessonTab === "summary" ? "active" : ""}" data-action="lesson-tab" data-id="summary">ملخص المراجعة</button><button class="article-tab ${lessonTab === "watch" ? "active" : ""}" data-action="lesson-tab" data-id="watch">الفيديوهات</button><button class="article-tab ${lessonTab === "questions" ? "active" : ""}" data-action="lesson-tab" data-id="questions">أسئلة تدريب</button></nav>
      <section class="card article-body">${renderLessonTab(lesson, unit, subject, matchingVideos)}</section></div>
      <aside class="article-aside"><section class="card aside-card"><h3>مرجع الدرس</h3><p>رقم الصفحة المطبوع كما يظهر في فهرس الكتاب، وقد يختلف عن رقم صفحة عارض PDF بسبب صفحات الغلاف.</p><div class="source-metadata"><span>المادة <b>${escapeHtml(subject.short)}</b></span><span>الوحدة <b>${escapeHtml(unit.id.split("-u").pop())}</b></span><span>الصفحة المطبوعة <b>${lesson.page}</b></span></div><button class="btn primary" style="width:100%;margin-top:12px" data-action="attach-book" data-id="${subject.id}">${state.bookMeta[subject.id] ? "فتح الكتاب" : "اختيار ملف الكتاب"}</button></section>
      <section class="card aside-card"><h3>قائمة متابعة الدرس</h3><ul><li>اقرأ عنوان الدرس وأهدافه في المصدر.</li><li>دوّن تعريفًا أو علاقة رئيسية من الكتاب.</li><li>حل مثالًا ثم سؤالًا من أنشطة الدرس.</li></ul></section>
      <section class="card aside-card"><h3>توزيع الدرجات</h3><p>لم يتم العثور على توزيع رسمي مؤكد لهذه الوحدة في الملفات المرفقة.</p></section></aside></div>`;
  }

  function renderLessonTab(lesson, unit, subject, matchingVideos) {
    const source = state.bookMeta[subject.id] ? renderBookViewer(subject, true) : `<div class="source-banner"><span class="source-banner-icon">▤</span><div><b>الشرح الكامل في كتاب الطالب</b><small>${escapeHtml(subject.book)} · الصفحة المطبوعة ${lesson.page}</small></div><button class="btn small" data-action="attach-book" data-id="${subject.id}">اختيار PDF</button></div>`;
    if (lessonTab === "study") return `<h2>خطة دراسة ${escapeHtml(lesson.title)}</h2><p>اعتمد على عنوان الدرس وموقعه في المنهج، ثم اقرأ الشرح والأمثلة في الكتاب. هذه الصفحة تحفظ مسار المراجعة وتفتح المصدر الأصلي الذي زوّدتنا به.</p>${source}<div class="study-steps"><div class="study-step"><span class="step-number">١</span><div><b>اقرأ الفكرة الأساسية</b><p>حدّد التعريف أو العلاقة أو المهارة التي يقدمها الدرس في الكتاب.</p></div></div><div class="study-step"><span class="step-number">٢</span><div><b>تابع المثال والشرح</b><p>اكتب خطوات المثال بترتيبها، وأعد حله دون النظر إلى الحل.</p></div></div><div class="study-step"><span class="step-number">٣</span><div><b>طبّق وتحقق</b><p>حل نشاطًا من الكتاب، ثم راجع الإجابة ووحدات القياس أو المصطلحات إن وجدت.</p></div></div></div><div class="save-box"><b>احفظ هذه النقاط</b><p>اكتب في دفترك: فكرة الدرس، المصطلح أو القانون الوارد في المصدر، وخطأ واحد ستتجنبه في الحل.</p></div>`;
    if (lessonTab === "summary") return `<h2>ملخص المراجعة</h2><p>هذا الملخص يثبت ترتيب الدراسة انطلاقًا من فهرس الملف، ولا يستبدل الشرح الكامل داخل الكتاب.</p><div class="study-steps"><div class="study-step"><span class="step-number">١</span><div><b>الموضوع</b><p>${escapeHtml(lesson.title)} · ${escapeHtml(unit.title)}</p></div></div><div class="study-step"><span class="step-number">٢</span><div><b>المصدر</b><p>${escapeHtml(subject.bookNote)}، الصفحة المطبوعة ${lesson.page}.</p></div></div><div class="study-step"><span class="step-number">٣</span><div><b>تحقق من فهمك</b><p>اشرح الفكرة بكلماتك، واكتب العلاقة أو الدليل الذي يستخدمه الكتاب، ثم حل سؤالًا من تدريباته.</p></div></div></div><div class="official-note">لا يحتوي فهرس الكتاب على توزيع درجات رسمي لهذه الجزئية. لم تُضف نسبة تقديرية.</div>${source}`;
    if (lessonTab === "watch") return `<h2>فيديوهات مرتبطة بالدرس</h2>${matchingVideos.length ? matchingVideos.map(videoCard).join("") : `<p>لم نعثر على فيديو مباشر موثّق لهذا العنوان ضمن المصادر التي جرى التحقق منها. يمكنك فتح بحث مطابق للدرس على يوتيوب.</p><a class="btn" target="_blank" rel="noopener noreferrer" href="${youtubeSearch(subject.name, lesson.title)}">ابحث عن «${escapeHtml(lesson.title)}» في يوتيوب ↗</a>`}${subject.id === "chem" ? `<p class="muted" style="margin-top:12px">المقاطع مرتبطة بصفحة فيديوهات كيمياء الصف الحادي عشر التي تنشرها معلمة المادة. افتح المصدر لعرض بقية المقاطع.</p><a class="text-link" target="_blank" rel="noopener noreferrer" href="https://sites.google.com/view/chem11oman/%D9%81%D9%8A%D8%AF%D9%8A%D9%88%D9%87%D8%A7%D8%AA-%D8%AA%D8%B9%D9%84%D9%8A%D9%85%D9%8A%D8%A9-%D9%88%D8%B9%D8%B1%D9%88%D8%B6">صفحة فيديوهات الكيمياء للصف الحادي عشر ↗</a>` : ""}`;
    if (lessonTab === "questions") {
    const related = questions.filter(question => question.subject === subject.id && question.unit === unit.id && question.lesson === lesson.title);
      return `<h2>أسئلة تدريب على الدرس</h2><p>الأسئلة ذات التصحيح التلقائي تدريبية أُعدّت من عنوان الموضوع ومفاهيمه العامة، وليست من امتحان وزاري. الأسئلة الكتابية تُراجع بالرجوع إلى المصدر.</p>${related.length ? `<button class="btn primary" data-action="start-lesson-quiz" data-id="${lesson.id}">ابدأ اختبارًا قصيرًا (${related.length})</button>` : `<div class="warning-box"><b>تدريب كتابي</b><p>دوّن إجابة: ما الفكرة الرئيسة في «${escapeHtml(lesson.title)}»؟ استشهد بمثال أو نشاط من الكتاب، ثم راجع إجابتك مع الشرح.</p></div>`}<div class="study-steps"><div class="study-step"><span class="step-number">١</span><div><b>سؤال قصير</b><p>عرّف المصطلح أو الفكرة التي يعرضها درس «${escapeHtml(lesson.title)}» حسب صياغة الكتاب.</p></div></div><div class="study-step"><span class="step-number">٢</span><div><b>سؤال تطبيق</b><p>اختر مثالًا أو تدريبًا من الكتاب، واشرح سبب اتباع خطوات الحل.</p></div></div><div class="study-step"><span class="step-number">٣</span><div><b>مراجعة ذاتية</b><p>قارن إجابتك بالنص أو نموذج الإجابة في المصدر، وسجل موضع الخطأ إن وجد.</p></div></div></div>`;
    }
    return "";
  }

  function renderLessonTab(lesson, unit, subject, matchingVideos) {
    const content = guideFor(lesson);
    const source = state.bookMeta[subject.id] ? renderBookViewer(subject, true) : "<div class=\"source-banner\"><span class=\"source-banner-icon\">▤</span><div><b>صفحة الكتاب الأصلية</b><small>" + escapeHtml(subject.book) + " · الصفحة المطبوعة " + lesson.page + "</small></div><button class=\"btn small\" data-action=\"attach-book\" data-id=\"" + subject.id + "\">اختيار PDF</button></div>";
    if (!content) return "<h2>شرح الدرس</h2><div class=\"warning-box\"><b>لا يتوفر ملخص موثوق لهذا الدرس بعد.</b><p>يمكنك قراءة الصفحة الأصلية من الكتاب المرفق أو إضافته لعرضه هنا.</p></div>" + source;
    if (lessonTab === "study") {
      return "<h2>شرح الدرس: " + escapeHtml(lesson.title) + "</h2><p class=\"lesson-teach\">" + escapeHtml(content.teach) + "</p><section class=\"concept-box\"><div class=\"eyebrow\">المهم</div><p>" + escapeHtml(content.important) + "</p></section><section class=\"worked-example\"><div class=\"eyebrow\">مثال مشروح</div><p>" + escapeHtml(content.example) + "</p></section><div class=\"study-next\"><span>بعد الشرح</span><button class=\"btn primary\" data-action=\"lesson-tab\" data-id=\"questions\">انتقل إلى التدريب ←</button></div>" + source;
    }
    if (lessonTab === "summary") {
      return "<h2>خلاصة سريعة</h2><p>" + escapeHtml(content.teach) + "</p><div class=\"save-box\"><b>الفكرة المهمة</b><p>" + escapeHtml(content.important) + "</p></div><div class=\"study-next\"><button class=\"btn primary\" data-action=\"lesson-tab\" data-id=\"questions\">حل أسئلة الدرس ←</button></div>";
    }
    if (lessonTab === "watch") {
      const videoHtml = matchingVideos.length ? matchingVideos.map(videoCard).join("") : "<p>لا يوجد فيديو محدد موثوق لهذا العنوان حتى الآن. يمكن فتح بحث بعنوان الدرس.</p><a class=\"btn\" target=\"_blank\" rel=\"noopener noreferrer\" href=\"" + youtubeSearch(subject.name, lesson.title) + "\">ابحث عن الدرس في يوتيوب ↗</a>";
      const chemSource = subject.id === "chem" ? "<p class=\"muted\" style=\"margin-top:12px\">المقاطع مرتبطة بصفحة فيديوهات الكيمياء للصف الحادي عشر.</p><a class=\"text-link\" target=\"_blank\" rel=\"noopener noreferrer\" href=\"https://sites.google.com/view/chem11oman/%D9%81%D9%8A%D8%AF%D9%8A%D9%88%D9%87%D8%A7%D8%AA-%D8%AA%D8%B9%D9%84%D9%8A%D9%85%D9%8A%D8%A9-%D9%88%D8%B9%D8%B1%D9%88%D8%B6\">صفحة فيديوهات الكيمياء ↗</a>" : "";
      return "<h2>فيديوهات مرتبطة بالدرس</h2>" + videoHtml + chemSource;
    }
    if (lessonTab === "questions") {
      const practice = content.practice.map((item, index) => "<article class=\"practice-question\"><div class=\"eyebrow\">سؤال تدريب " + (index + 1) + "</div><h3>" + escapeHtml(item.q) + "</h3><details><summary>اعرض الحل المشروح</summary><p>" + escapeHtml(item.a) + "</p></details></article>").join("");
      const bank = questions.filter(question => question.subject === subject.id && question.unit === unit.id && question.lesson === lesson.title);
      const bankButton = bank.length ? "<button class=\"btn\" data-action=\"start-lesson-quiz\" data-id=\"" + lesson.id + "\">تدريب اختيار من متعدد (" + bank.length + ")</button>" : "";
      const checks = content.quiz.map((item, index) => ({ q: item.q, a: item.a, lesson: lesson.title, id: lesson.id + "-check-" + index }));
      return "<h2>تدريب على الدرس</h2><p>حاول الحل قبل فتح الإجابة النموذجية. بعد التدريب ابدأ الاختبار القصير؛ صحّح إجابتك بنفسك لأن الإجابة المقالية قد تقبل أكثر من صياغة.</p>" + practice + "<div class=\"study-next\"><button class=\"btn primary\" data-action=\"start-lesson-test\" data-id=\"" + lesson.id + "\">ابدأ الاختبار القصير</button>" + bankButton + "</div>";
    }
    return "";
  }

  function renderBookViewer(subject, compact = false) {
    const url = activePdfUrls.get(subject.id);
    const loaded = !!state.bookMeta[subject.id];
    return `<section class="${compact ? "source-banner" : "card card-pad"}">${compact ? "" : `<div class="section-head" style="margin:0 0 10px"><div><h2>الكتاب المصدر</h2><p>${escapeHtml(subject.bookNote)}</p></div></div>`}${url ? `<iframe title="${escapeHtml(subject.name)} PDF" src="${url}#toolbar=1&navpanes=0" style="width:100%;height:${compact ? "480px" : "540px"};border:1px solid var(--line);border-radius:12px;background:#fff"></iframe>` : `<div class="source-banner"><span class="source-banner-icon">▤</span><div><b>${loaded ? "ملف الكتاب محفوظ على هذا الجهاز" : "اربط نسخة الكتاب من جهازك"}</b><small>${escapeHtml(subject.book)} · ${subject.bookPages} صفحة بحسب المرفق</small></div><button class="btn small" data-action="attach-book" data-id="${subject.id}">${loaded ? "فتح" : "اختيار PDF"}</button></div>`}</section>`;
  }

  function renderChemVideos() {
    return `<div class="section-head"><div><h2>فيديوهات الكيمياء</h2><p>مقاطع محددة من صفحة تعليمية للصف الحادي عشر</p></div></div><div class="resource-list">${(window.CHEMISTRY_VIDEOS || []).slice(0, 5).map(videoCard).join("")}</div>`;
  }
  function videoCard(video) {
    return `<a class="resource-card" target="_blank" rel="noopener noreferrer" href="https://www.youtube.com/watch?v=${video.id}"><img src="https://img.youtube.com/vi/${video.id}/mqdefault.jpg" alt="" loading="lazy" style="width:74px;height:48px;object-fit:cover;border-radius:8px"><div><h3>${escapeHtml(video.title)}</h3><p>مقطع يوتيوب مرتبط بموضوع من منهج الكيمياء للصف الحادي عشر</p></div><span class="external-arrow">↗</span></a>`;
  }
  function youtubeSearch(subject, lesson) {
    const query = `شرح ${subject} الصف الحادي عشر سلطنة عمان ${lesson}`;
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  }

  function renderWeekStrip(editor = false) {
    const dayNames = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    const today = new Date().getDay();
    if (editor) return `<div class="schedule-editor">${dayNames.map((day, index) => `<div class="schedule-row"><label>${day}</label><select data-schedule-day="${index}"><option value="">دون مادة</option>${curriculum.map(subject => `<option value="${subject.id}" ${state.schedule[index] === subject.id ? "selected" : ""}>${escapeHtml(subject.short)}</option>`).join("")}</select></div>`).join("")}</div>`;
    return `<div class="week-strip">${dayNames.map((day,index) => { const subjectId = state.schedule[index]; const subject = courseById.get(subjectId); return `<div class="week-day ${index === today ? "today" : ""}"><div class="week-day-head"><span>${day}</span>${index === today ? "<b>اليوم</b>" : ""}</div>${subject ? `<span class="week-entry" style="border-right:2px solid ${subject.color}">${escapeHtml(subject.short)}</span>` : `<span class="week-entry muted">—</span>`}</div>`; }).join("")}</div>`;
  }
  function renderDeadline() {
    if (!state.examDate) return `<section class="deadline-card"><div><b>موعد الاختبارات</b><small>أضف تاريخًا ليظهر العد التنازلي</small></div><button class="btn small" data-action="set-exam-date">إضافة تاريخ</button></section>`;
    const days = Math.ceil((new Date(`${state.examDate}T23:59:00`) - new Date()) / 86400000);
    return `<section class="deadline-card"><div><b>العد التنازلي للاختبارات</b><small>${escapeHtml(state.examDate)}</small><button class="text-link" data-action="set-exam-date">تغيير التاريخ</button></div><div class="deadline-count">${days < 0 ? "—" : days}<small>${days < 0 ? "حدّث الموعد" : "يومًا"}</small></div></section>`;
  }
  function taskRow(task) {
    return `<label class="task-row ${task.done ? "done" : ""}"><input class="task-check" type="checkbox" data-task-toggle="${task.id}" ${task.done ? "checked" : ""}><span>${escapeHtml(task.title)}</span><small class="task-due">${task.due ? escapeHtml(task.due) : ""}</small></label>`;
  }

  function renderRevision() {
    setCrumb("مراجعة الأخطاء");
    const missed = state.mistakes.map(id => questions.find(item => item.id === id)).filter(Boolean);
    const recent = state.attempts.slice(-5).reverse();
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">تعلّم من محاولاتك</div><h1>مراجعة الأخطاء</h1><p>الأسئلة التي أخطأت فيها تظهر هنا للعودة إليها.</p></div><div class="heading-actions"><button class="btn primary" data-action="start-mistake-quiz" ${missed.length ? "" : "disabled"}>اختبر أخطائي (${missed.length})</button></div></div>
      <div class="page-grid-2"><section class="card card-pad"><div class="section-head" style="margin-top:0"><div><h2>أسئلة تحتاج إعادة مراجعة</h2><p>تختفي من هذه القائمة بعد إجابة صحيحة لاحقة.</p></div></div>${missed.length ? `<div class="resource-list">${missed.map(item => `<button class="resource-card" data-action="open-question-review" data-id="${item.id}" style="text-align:right;cursor:pointer"><span class="resource-icon">↺</span><div><h3>${escapeHtml(item.prompt)}</h3><p>${escapeHtml(courseById.get(item.subject)?.short || "مادة")} · ${escapeHtml(unitById.get(item.unit)?.title || "")}</p></div><span class="external-arrow">←</span></button>`).join("")}</div>` : `<div class="empty-note">أحسنت، لا توجد أخطاء مسجلة حتى الآن.<br>ابدأ اختبارًا قصيرًا لتكوين سجل المراجعة.</div>`}<div class="section-head"><div><h2>الدروس المحفوظة</h2><p>${state.favorites.length} درسًا في المفضلة</p></div></div>${state.favorites.length ? `<div class="resource-list">${state.favorites.map(id => lessonById.get(id)).filter(Boolean).map(item => `<button class="resource-card" data-action="open-lesson" data-id="${item.id}" style="text-align:right;cursor:pointer"><span class="resource-icon">★</span><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.subjectName)} · ${escapeHtml(item.unitTitle)}</p></div><span class="external-arrow">←</span></button>`).join("")}</div>` : `<div class="empty-note">استخدم زر «حفظ» داخل الدرس لإضافته إلى المفضلة.</div>`}</section>
      <section class="card card-pad"><div class="section-head" style="margin-top:0"><div><h2>آخر المحاولات</h2><p>تُحفظ النتائج على هذا الجهاز فقط.</p></div></div>${recent.length ? `<div class="resource-list">${recent.map(attempt => `<div class="resource-card"><span class="resource-icon">${attempt.score >= attempt.total * .6 ? "✓" : "↺"}</span><div><h3>${escapeHtml(courseById.get(attempt.subjectId)?.short || "اختبار عشوائي")} · ${attempt.score}/${attempt.total}</h3><p>${new Date(attempt.date).toLocaleDateString("ar-OM")}</p></div></div>`).join("")}</div>` : `<div class="empty-note">لا توجد محاولات محفوظة.</div>`}</section></div>`;
  }

  function renderExams() {
    setCrumb("بنك الاختبارات");
    const attempts = state.attempts.slice(-4).reverse();
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">تدريب وتقييم</div><h1>بنك الاختبارات</h1><p>ابدأ اختبارًا تدريبيًا من الأسئلة ذات الإجابة المحددة أو افتح بوابة الاختبارات الرسمية.</p></div></div>
      <div class="page-grid-2"><section class="card settings-panel"><h2>إعداد اختبار تدريبي</h2><div class="field"><label for="quizSubject">المادة</label><select id="quizSubject"><option value="all">كل المواد ذات الأسئلة المتاحة</option>${curriculum.filter(item => questions.some(question => question.subject === item.id)).map(subject => `<option value="${subject.id}">${escapeHtml(subject.name)}</option>`).join("")}</select></div><div class="field"><label for="quizUnit">الوحدة</label><select id="quizUnit"><option value="all">كل وحدات المادة المختارة</option></select></div><div class="field"><label for="quizCount">عدد الأسئلة</label><select id="quizCount"><option value="5">٥ أسئلة</option><option value="10">١٠ أسئلة</option><option value="15">١٥ سؤالًا</option><option value="all">كل الأسئلة المتاحة</option></select></div><div class="field"><label for="quizTimer">الوقت</label><select id="quizTimer"><option value="0">دون مؤقت</option><option value="10">١٠ دقائق</option><option value="20">٢٠ دقيقة</option><option value="30">٣٠ دقيقة</option></select></div><button class="btn primary" data-action="submit-quiz-setup">ابدأ الاختبار ←</button><p class="muted" style="margin-top:10px;font-size:9px">هذه أسئلة تدريبية أصلية مبنية على موضوعات المنهج، وليست أسئلة وزارية أو امتحانات سابقة.</p></section>
      <section class="card card-pad"><div class="section-head" style="margin-top:0"><div><h2>الامتحانات السابقة</h2><p>مصادر خارجية موثوقة؛ لا نعرض ملفًا غير متحقق منه.</p></div></div><div class="exam-disclaimer">تذكر البوابة التعليمية للوزارة إتاحة امتحانات سابقة وتجريبية ونماذج إجابة للصفوف 10–12. لم تُرفق ملفات امتحانات رسمية ضمن هذه الحزمة، لذا لا يعرض الموقع ملفات أو درجات غير مؤكدة.</div><div class="resource-list" style="margin-top:11px"><article class="exam-card"><span class="resource-icon">▤</span><div><h3>الامتحانات السابقة · بوابة الطالب</h3><p>صفحة خدمات الطلبة الرسمية التابعة لوزارة التعليم.</p></div><a class="btn small" target="_blank" rel="noopener noreferrer" href="https://site.moe.gov.om/Students">فتح ↗</a></article><article class="exam-card"><span class="resource-icon">⌂</span><div><h3>زاويتي التعليمية</h3><p>مرتبطة من بوابة الطالب، وتضم امتحانات ومواد تقويمية.</p></div><a class="btn small" target="_blank" rel="noopener noreferrer" href="https://zawity.moe.gov.om/">فتح ↗</a></article></div></section></div>
      <div class="section-head"><div><h2>سجل المحاولات</h2><p>آخر نتيجة محفوظة محليًا</p></div></div>${attempts.length ? `<div class="resource-list">${attempts.map(item => `<div class="resource-card"><span class="resource-icon">${item.score / item.total >= .6 ? "✓" : "↺"}</span><div><h3>${escapeHtml(courseById.get(item.subjectId)?.name || "اختبار متنوع")} · ${item.score} من ${item.total}</h3><p>${new Date(item.date).toLocaleString("ar-OM")} · ${item.wrongIds.length} إجابات تحتاج مراجعة</p></div><button class="btn small" data-action="open-attempt-mistakes" data-id="${item.date}">راجع الأخطاء</button></div>`).join("")}</div>` : `<section class="card empty-note">لم تبدأ اختبارًا بعد.</section>`}`;
    updateQuizUnitOptions();
  }

  function updateQuizUnitOptions() {
    const subjectSelect = $("#quizSubject");
    const unitSelect = $("#quizUnit");
    if (!subjectSelect || !unitSelect) return;
    const subjectId = subjectSelect.value;
    const list = subjectId === "all" ? [] : allUnits(subjectId).filter(unit => questions.some(question => question.unit === unit.id));
    unitSelect.innerHTML = `<option value="all">كل وحدات المادة المختارة</option>${list.map(unit => `<option value="${unit.id}">${escapeHtml(unit.title)}</option>`).join("")}`;
    unitSelect.disabled = subjectId === "all" || !list.length;
  }

  function renderFlashcards() {
    setCrumb("بطاقات المراجعة");
    const chosen = terms.length ? terms[flashIndex % terms.length] : null;
    const display = chosen ? `<button class="flashcard" data-action="flip-card" aria-label="اقلب البطاقة"><div><span class="flash-type">${flashFlipped ? "المعنى" : "المصطلح"}</span><h2>${escapeHtml(flashFlipped ? chosen.meaning : chosen.term)}</h2><p>${flashFlipped ? escapeHtml(courseById.get(chosen.subject)?.short || "") : "اضغط لإظهار المعنى"}</p></div></button>` : `<div class="empty-note">لا توجد بطاقات.</div>`;
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">استرجاع نشط</div><h1>بطاقات المراجعة</h1><p>مصطلحات وعلاقات أساسية مستخرجة أو مرتبطة بعناوين الدروس.</p></div><button class="btn" data-action="shuffle-cards">خلط البطاقات ↻</button></div><div class="flashcard-wrap">${display}<div class="flash-counter">${terms.length ? flashIndex + 1 : 0} / ${terms.length}</div><div class="flash-controls"><button class="btn" data-action="previous-card">→ السابقة</button><button class="btn primary" data-action="flip-card">اقلب البطاقة</button><button class="btn" data-action="next-card">التالية ←</button></div></div>`;
  }

  function renderPlanner() {
    setCrumb("خطتي الدراسية");
    const tasks = state.tasks.slice().sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">نظّم وقتك</div><h1>خطتي الدراسية</h1><p>أضف مهامك واضبط المواد التي تريد تخصيصها لكل يوم.</p></div></div><div class="planner-grid"><section class="card planner-panel"><h2>المهام الدراسية</h2>${tasks.length ? tasks.map(task => `<div class="planner-task">${taskRow(task)}<button class="delete-task" data-action="delete-task" data-id="${task.id}" aria-label="حذف المهمة">×</button></div>`).join("") : `<div class="empty-note">أضف أول مهمة صغيرة لتبدأ خطتك.</div>`}<form class="task-form" id="taskForm"><input name="title" maxlength="100" required placeholder="مثال: مراجعة مسائل الوحدة الثانية"><input name="due" type="date" aria-label="تاريخ المهمة"><button class="btn primary" type="submit">إضافة</button></form></section><section class="card planner-panel"><h2>جدول أسبوعي مرن</h2>${renderWeekStrip(true)}<button class="btn primary" style="margin-top:13px" data-action="save-schedule">حفظ الجدول</button></section></div>`;
  }

  function renderAssistant() {
    setCrumb("مساعدي الدراسي");
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">مساندة من خريطة المنهج</div><h1>مساعدي الدراسي</h1><p>ابحث عن مفهوم أو عنوان، وسأرشدك إلى موضعه في الكتب المسجلة.</p></div></div><div class="assistant-layout"><section class="card assistant-panel"><h2>ما الذي تريد مراجعته؟</h2><p>اكتب كلمة أو سؤالًا قصيرًا للعثور على الدروس القريبة في خريطة المصادر.</p><form class="assistant-form" id="assistantForm"><textarea name="query" required placeholder="مثال: ما الفرق بين السرعة والإزاحة؟"></textarea><button class="btn primary" type="submit">ابحث في المنهج ←</button></form><div class="assistant-response" id="assistantResponse">سأطابق كلمات سؤالك مع عناوين الدروس والمصطلحات المسجلة. عند عدم وجود مصدر مطابق سأخبرك بذلك.</div></section><aside class="assistant-note"><b>عن المساعد</b><p>هذه نسخة محلية تعمل دون حساب أو مفتاح خدمة خارجي. تفهرس عناوين الدروس والمصطلحات المدرجة فقط؛ لا تنشئ حلولًا من محتوى غير موجود، ولا تدّعي أنها نموذج ذكاء اصطناعي متصل بالإنترنت. افتح الكتاب لقراءة الشرح الكامل.</p></aside></div>`;
  }

  function renderResources() {
    setCrumb("المكتبة والموارد");
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">مصادر موثوقة</div><h1>المكتبة والموارد</h1><p>روابط رسمية ومراجع تعليمية جرى التحقق من ارتباطها بمنهج الصف الحادي عشر.</p></div></div><div class="page-grid-2"><section class="card card-pad"><div class="section-head" style="margin-top:0"><div><h2>بوابة وزارة التعليم</h2><p>للوصول إلى الكتب والامتحانات والخدمات الطلابية</p></div></div><div class="resource-list"><article class="resource-card"><span class="resource-icon">▤</span><div><h3>المكتبة الرقمية للمناهج العُمانية</h3><p>تصف وزارة التعليم المكتبة الرقمية بأنها تضم الكتب المدرسية والمناهج.</p></div><a class="btn small" target="_blank" rel="noopener noreferrer" href="https://home.moe.gov.om/ar/manaheg/index.moe">فتح ↗</a></article><article class="resource-card"><span class="resource-icon">⌂</span><div><h3>بوابة الطالب</h3><p>تتضمن روابط المكتبة الرقمية والامتحانات السابقة وزاويتي التعليمية.</p></div><a class="btn small" target="_blank" rel="noopener noreferrer" href="https://site.moe.gov.om/Students">فتح ↗</a></article><article class="resource-card"><span class="resource-icon">✓</span><div><h3>زاويتي التعليمية</h3><p>بنك أسئلة وامتحانات سابقة وأنشطة تقويمية للمواد الدراسية.</p></div><a class="btn small" target="_blank" rel="noopener noreferrer" href="https://zawity.moe.gov.om/">فتح ↗</a></article></div></section><section class="card card-pad"><div class="section-head" style="margin-top:0"><div><h2>فيديوهات الشرح</h2><p>القوائم المباشرة الموثقة حاليًا</p></div></div><div class="resource-list"><article class="resource-card"><span class="resource-icon">▶</span><div><h3>فيديوهات كيمياء الصف الحادي عشر</h3><p>قائمة دروس ومراجعات للوحدات الأولى إلى الخامسة.</p></div><a class="btn small" target="_blank" rel="noopener noreferrer" href="https://sites.google.com/view/chem11oman/%D9%81%D9%8A%D8%AF%D9%8A%D9%88%D9%87%D8%A7%D8%AA-%D8%AA%D8%B9%D9%84%D9%8A%D9%85%D9%8A%D8%A9-%D9%88%D8%B9%D8%B1%D9%88%D8%B6">فتح ↗</a></article><article class="resource-card"><span class="resource-icon">▶</span><div><h3>مراجعة عامة في الكيمياء · الفصل الأول</h3><p>محمد صالح · الصف الحادي عشر · مناهج سلطنة عُمان.</p></div><a class="btn small" target="_blank" rel="noopener noreferrer" href="https://www.youtube.com/watch?v=E7Kznc2_-To">فتح ↗</a></article></div><div class="official-note" style="margin-top:12px">للمواد التي لم يُتحقق فيها من مقاطع محددة، يوفر كل درس رابط بحث مخصصًا بعنوانه بدل عرض فيديو غير مؤكد.</div></section></div>`;
  }

  function renderSettings() {
    setCrumb("الإعدادات");
    const bookRows = curriculum.map(subject => {
      const meta = state.bookMeta[subject.id];
      return `<div class="source-book-row"><span class="book-status">${meta ? "✓" : "▤"}</span><div><b>${escapeHtml(subject.short)}</b><small>${meta ? `مرتبط: ${escapeHtml(meta.name)}` : `المرفق: ${escapeHtml(subject.book)}`}</small></div><button class="btn small" data-action="attach-book" data-id="${subject.id}">${meta ? "فتح / استبدال" : "إضافة"}</button>${meta ? `<button class="btn small danger" data-action="clear-book" data-id="${subject.id}">إزالة</button>` : ""}</div>`;
    }).join("");
    $("#pageContent").innerHTML = `<div class="page-heading"><div><div class="eyebrow">إعدادات جهازك</div><h1>الإعدادات</h1><p>بياناتك وتقدمك محفوظة محليًا في هذا المتصفح.</p></div></div><div class="settings-grid"><section class="card settings-panel"><h2>ملف الطالب</h2><form id="settingsForm"><div class="field"><label for="studentNameInput">الاسم المعروض</label><input id="studentNameInput" name="name" maxlength="32" value="${escapeHtml(state.name)}" placeholder="طالب الصف الحادي عشر"></div><div class="field"><label for="examDateInput">موعد الاختبار</label><input id="examDateInput" name="examDate" type="date" value="${escapeHtml(state.examDate)}"><small>يظهر عدّ تنازلي في لوحة التحكم عند حفظ التاريخ.</small></div><button class="btn primary" type="submit">حفظ الإعدادات</button></form><div class="toggle-row"><div><b>تنبيهات المهام</b><small>إظهار نقطة على رمز التنبيهات عند وجود مهمة مستحقة.</small></div><input class="switch" id="reminderSwitch" type="checkbox" ${state.reminder ? "checked" : ""}></div></section><section class="card settings-panel"><h2>المظهر والبيانات</h2><div class="toggle-row"><div><b>الوضع الداكن</b><small>مظهر مريح للمراجعة المسائية.</small></div><input class="switch" id="darkSwitch" type="checkbox" ${state.theme === "dark" ? "checked" : ""}></div><div class="toggle-row"><div><b>تصدير التقدم</b><small>احفظ المهام والنتائج والإعدادات كملف JSON.</small></div><button class="btn small" data-action="export-data">تصدير</button></div><div class="toggle-row"><div><b>استيراد التقدم</b><small>استعد نسخة سبق تصديرها.</small></div><button class="btn small" data-action="import-data">استيراد</button></div><div class="toggle-row"><div><b>مسح بيانات التقدم</b><small>يحذف المهام والمراجعات والإعدادات المحلية.</small></div><button class="btn small danger" data-action="reset-data">مسح</button></div></section></div><div class="section-head"><div><h2>كتبك المحلية</h2><p>تُخزن ملفات PDF في قاعدة بيانات المتصفح على جهازك ولا تُرسل إلى خادم.</p></div></div><section class="card card-pad">${bookRows}<div class="official-note">تحتاج إلى اختيار الملفات من جهازك بعد فتح الموقع على متصفحك. أحجام النسخ الأصلية كبيرة؛ لذلك لا تُضمّن داخل مستودع GitHub العام.</div></section>`;
  }

  function renderQuiz() {
    if (!quizState) return navTo("exams");
    const question = quizState.questions[quizState.index];
    const selected = quizState.answers[question.id];
    const hasAnswer = selected !== undefined;
    const unit = unitById.get(question.unit);
    const progress = pct(quizState.index + 1, quizState.questions.length);
    const timerText = quizState.limitMinutes ? formatTime(quizState.remaining) : "دون مؤقت";
    setCrumb("الاختبار التدريبي");
    $("#pageContent").innerHTML = `<div class="quiz-shell"><div class="page-heading"><div><div class="eyebrow">${escapeHtml(courseById.get(question.subject)?.short || "تدريب متنوع")} · ${escapeHtml(unit?.title || "")}</div><h1>اختبار تدريبي</h1><p>سجّل إجاباتك ثم راجع الدرجة والتفسير.</p></div><button class="btn danger" data-action="finish-quiz">إنهاء الاختبار</button></div><section class="card quiz-progress"><small>السؤال ${quizState.index + 1} من ${quizState.questions.length}</small><span class="progress-track"><span style="width:${progress}%"></span></span><small data-timer>${timerText}</small></section><section class="card question-card"><div class="question-kicker"><span>${escapeHtml(question.lesson)}</span><span>تدريب غير وزاري</span></div><h2>${escapeHtml(question.prompt)}</h2><div class="answer-list">${question.options.map((option,index) => `<button class="answer-option ${selected === index ? "selected" : ""}" data-action="choose-answer" data-id="${index}"><span class="answer-letter">${"أ ب ج د".split(" ")[index]}</span><span>${escapeHtml(option)}</span></button>`).join("")}</div><div class="quiz-controls"><button class="btn" data-action="previous-question" ${quizState.index === 0 ? "disabled" : ""}>→ السابق</button><button class="btn primary" data-action="${quizState.index === quizState.questions.length - 1 ? "finish-quiz" : "next-question"}">${quizState.index === quizState.questions.length - 1 ? "إنهاء وتصحيح" : "التالي ←"}</button></div>${hasAnswer ? `<div class="quiz-feedback">تم تسجيل اختيارك. تظهر الإجابة الصحيحة بعد إنهاء الاختبار.</div>` : ""}</section></div>`;
  }

  function formatTime(seconds) {
    const value = Math.max(0, seconds || 0);
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }
  function renderQuizResult(result) {
    const percent = pct(result.score, result.total);
    const rows = result.questions.map(question => {
      const selected = result.answers[question.id];
      const correct = selected === question.answer;
      return `<div class="result-review-row ${correct ? "correct" : "wrong"}"><b>${correct ? "إجابة صحيحة" : "تحتاج مراجعة"} · ${escapeHtml(question.prompt)}</b><span>${selected === undefined ? "لم تجب عن السؤال." : `إجابتك: ${escapeHtml(question.options[selected])}`}</span><br><span>الإجابة الصحيحة: ${escapeHtml(question.options[question.answer])}</span><br><span>${escapeHtml(question.explain)}</span></div>`;
    }).join("");
    setCrumb("نتيجة الاختبار");
    $("#pageContent").innerHTML = `<div class="quiz-shell"><div class="page-heading"><div><div class="eyebrow">نتيجة المحاولة</div><h1>مراجعة الاختبار</h1></div><div class="heading-actions"><button class="btn" data-action="back-to-quiz-source">العودة إلى صفحة الاختبارات</button></div></div><section class="card quiz-result"><div class="score-ring"><span>${percent}٪</span></div><h2>${result.score} من ${result.total}</h2><p>${percent >= 60 ? "أداء جيد. راجع التفسيرات لتثبيت المفاهيم." : "ارجع إلى الدروس التي ظهرت في هذه المحاولة، ثم أعد الاختبار."}</p><div class="heading-actions"><button class="btn primary" data-action="retake-quiz">إعادة الاختبار بأسئلة مرتبة عشوائيًا</button><button class="btn" data-action="open-mistakes">مراجعة الأخطاء</button></div><div class="result-review">${rows}</div></section></div>`;
  }

  function assessmentRowsForLesson(lesson) {
    const content = guideFor(lesson);
    return (content?.quiz || []).map((item, index) => ({
      id: lesson.id + "-q" + index, q: item.q, a: item.a, lesson: lesson.title, unit: lesson.unitTitle
    }));
  }
  function startGuideAssessment(kind, id) {
    let subjectId = null;
    let title = "";
    let rows = [];
    if (kind === "lesson") {
      const lesson = lessonById.get(id);
      if (!lesson) return;
      subjectId = lesson.subjectId;
      title = "اختبار قصير: " + lesson.title;
      rows = assessmentRowsForLesson(lesson);
    } else if (kind === "unit") {
      const unit = unitById.get(id);
      if (!unit) return;
      subjectId = unit.subjectId;
      title = "اختبار الوحدة: " + unit.title;
      rows = [...lessonById.values()].filter(lesson => lesson.unitId === id).flatMap(lesson => assessmentRowsForLesson(lesson).slice(0, 1));
    } else {
      const subject = courseById.get(id);
      if (!subject) return;
      subjectId = subject.id;
      title = "اختبار شامل تدريبي: " + subject.name;
      rows = subject.units.flatMap(unit => {
        const list = [...lessonById.values()].filter(lesson => lesson.unitId === unit.id);
        const chosen = list.length > 1 ? [list[0], list[list.length - 1]] : list;
        return chosen.flatMap(lesson => assessmentRowsForLesson(lesson).slice(0, 1));
      });
    }
    if (!rows.length) { toast("لا تتوفر أسئلة لهذا الاختيار بعد."); return; }
    assessmentState = { kind, subjectId, title, questions: rows, answers: {}, ratings: {} };
    if (quizState?.timerId) clearInterval(quizState.timerId);
    quizState = null;
    activePage = "exams";
    renderSelfAssessment();
  }
  function renderSelfAssessment() {
    if (!assessmentState) return;
    setCrumb("اختبار تدريبي");
    const rows = assessmentState.questions.map((item, index) => {
      const rating = assessmentState.ratings[index];
      return "<article class=\"self-question card\"><div class=\"question-kicker\"><span>" + escapeHtml(item.unit) + " · " + escapeHtml(item.lesson) + "</span><span>سؤال تدريبي</span></div><h3>" + escapeHtml(item.q) + "</h3><label class=\"field\"><span>اكتب إجابتك هنا</span><textarea data-assessment-answer=\"" + index + "\" rows=\"3\" placeholder=\"اكتب خطواتك أو إجابتك...\"></textarea></label><details><summary>افتح الإجابة النموذجية</summary><p>" + escapeHtml(item.a) + "</p></details><div class=\"self-rating\" data-rating-for=\"" + index + "\"><span>قيّم إجابتك بعد المراجعة</span><button class=\"btn small " + (rating === true ? "soft" : "") + "\" data-action=\"rate-self-answer\" data-id=\"" + index + "\" data-value=\"right\">أتقنتها</button><button class=\"btn small " + (rating === false ? "soft" : "") + "\" data-action=\"rate-self-answer\" data-id=\"" + index + "\" data-value=\"review\">أحتاج مراجعة</button></div></article>";
    }).join("");
    $("#pageContent").innerHTML = "<div class=\"quiz-shell\"><div class=\"page-heading\"><div><div class=\"eyebrow\">تقييم ذاتي · " + assessmentState.questions.length + " سؤالًا</div><h1>" + escapeHtml(assessmentState.title) + "</h1><p>اكتب إجابتك أولًا، ثم افتح الحل النموذجي وقيّم نفسك. هذا تدريب للمراجعة وليس اختبارًا وزاريًا.</p></div><button class=\"btn\" data-action=\"cancel-self-assessment\">رجوع</button></div><div class=\"self-assessment-list\">" + rows + "</div><div class=\"self-submit\"><button class=\"btn primary\" data-action=\"finish-self-assessment\">إنهاء وعرض نتيجتي</button></div></div>";
    $$("[data-assessment-answer]").forEach(field => { field.value = assessmentState.answers[field.dataset.assessmentAnswer] || ""; });
  }
  function finishSelfAssessment() {
    if (!assessmentState) return;
    const current = assessmentState;
    const score = Object.values(current.ratings).filter(value => value === true).length;
    const total = current.questions.length;
    const wrongIds = current.questions.filter((item, index) => current.ratings[index] !== true).map(item => item.id);
    state.attempts.push({ date: new Date().toISOString(), subjectId: current.subjectId, score, total, wrongIds, kind: current.kind });
    state.attempts = state.attempts.slice(-100);
    saveState();
    renderSelfAssessmentResult(current, score);
  }
  function renderSelfAssessmentResult(current, score) {
    const rows = current.questions.map((item, index) => {
      const okay = current.ratings[index] === true;
      return "<div class=\"result-review-row " + (okay ? "correct" : "wrong") + "\"><b>" + (okay ? "أتقنتها" : "تحتاج مراجعة") + " · " + escapeHtml(item.lesson) + "</b><span>السؤال: " + escapeHtml(item.q) + "</span><br><span>إجابتك: " + escapeHtml(current.answers[index] || "لم تُكتب إجابة.") + "</span><br><span>الإجابة النموذجية: " + escapeHtml(item.a) + "</span></div>";
    }).join("");
    $("#pageContent").innerHTML = "<div class=\"quiz-shell\"><div class=\"page-heading\"><div><div class=\"eyebrow\">نتيجة التقييم الذاتي</div><h1>" + escapeHtml(current.title) + "</h1></div><button class=\"btn\" data-action=\"cancel-self-assessment\">العودة للمادة</button></div><section class=\"card quiz-result\"><div class=\"score-ring\"><span>" + pct(score, current.questions.length) + "٪</span></div><h2>" + score + " من " + current.questions.length + " أتقنتها</h2><p>هذه نتيجة تقييمك لنفسك بعد مقارنة إجاباتك بالحلول النموذجية.</p><div class=\"result-review\">" + rows + "</div></section></div>";
    $(".quiz-result")?.insertAdjacentHTML("afterbegin", "<div class=\"heading-actions\" style=\"justify-content:center;margin-bottom:14px\"><button class=\"btn primary\" data-action=\"retake-self-assessment\">أعد المحاولة</button></div>");
  }
  function renderTaskList() { renderPlanner(); }
  function openLessonById(lessonId) {
    const lesson = lessonById.get(lessonId);
    if (lesson) renderLesson(lesson.subjectId, lesson.unitId, lesson.id);
  }
  function findQuestions(filter = {}) {
    return questions.filter(item => (!filter.subjectId || item.subject === filter.subjectId) && (!filter.unitId || item.unit === filter.unitId) && (!filter.lessonId || item.lesson === lessonById.get(filter.lessonId)?.title) && (!filter.ids || filter.ids.includes(item.id)));
  }
  function shuffle(list) {
    const copy = list.slice();
    for (let index = copy.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[other]] = [copy[other], copy[index]];
    }
    return copy;
  }
  function startQuiz(filter = {}, count = "all", minutes = 0) {
    let list = findQuestions(filter);
    if (!list.length) { toast("لا توجد أسئلة تدريبية لهذا الاختيار حتى الآن."); return; }
    list = shuffle(list);
    const amount = count === "all" ? list.length : Math.min(Number(count) || 5, list.length);
    list = list.slice(0, amount);
    quizState = { questions: list, answers: {}, index: 0, filter, limitMinutes: Number(minutes) || 0, remaining: (Number(minutes) || 0) * 60, timerId: null };
    if (quizState.limitMinutes) quizState.timerId = setInterval(() => {
      if (!quizState) return;
      quizState.remaining -= 1;
      const timer = $("[data-timer]");
      if (timer) timer.textContent = formatTime(quizState.remaining);
      if (quizState.remaining <= 0) finishQuiz();
    }, 1000);
    activePage = "exams";
    renderQuiz();
  }
  function finishQuiz() {
    if (!quizState) return;
    clearInterval(quizState.timerId);
    const current = quizState;
    const score = current.questions.reduce((sum, item) => sum + (current.answers[item.id] === item.answer ? 1 : 0), 0);
    const wrongIds = current.questions.filter(item => current.answers[item.id] !== item.answer).map(item => item.id);
    for (const item of current.questions) {
      if (current.answers[item.id] === item.answer) state.mistakes = state.mistakes.filter(id => id !== item.id);
      else if (!state.mistakes.includes(item.id)) state.mistakes.push(item.id);
    }
    const subjectIds = [...new Set(current.questions.map(item => item.subject))];
    const attempt = { date: new Date().toISOString(), subjectId: subjectIds.length === 1 ? subjectIds[0] : null, score, total: current.questions.length, wrongIds };
    state.attempts.push(attempt);
    state.attempts = state.attempts.slice(-100);
    saveState();
    window.lastQuizResult = { filter: current.filter, questions: current.questions.map(item => item.id) };
    quizState = null;
    renderQuizResult({ ...current, score, total: current.questions.length });
  }

  function showModal(title, subtitle, body, actions = "") {
    $("#modal").innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle || "")}</p></div><button class="modal-close" data-action="close-modal" aria-label="إغلاق">×</button></div>${body}${actions ? `<div class="modal-actions">${actions}</div>` : ""}`;
    $("#modalBackdrop").classList.remove("hidden");
  }
  function closeModal() { $("#modalBackdrop").classList.add("hidden"); }
  function openNameModal() {
    showModal("تعديل الاسم", "الاسم المعروض في لوحة التحكم", `<div class="field"><label for="nameEdit">اسم الطالب</label><input id="nameEdit" maxlength="32" value="${escapeHtml(state.name)}" placeholder="طالب الصف الحادي عشر"></div>`, `<button class="btn" data-action="close-modal">إلغاء</button><button class="btn primary" data-action="save-name">حفظ</button>`);
    setTimeout(() => $("#nameEdit")?.focus(), 0);
  }
  function setExamDateModal() {
    showModal("موعد الاختبار", "اختر التاريخ الذي تريد متابعته", `<div class="field"><label for="dateEdit">تاريخ الاختبار</label><input id="dateEdit" type="date" value="${escapeHtml(state.examDate)}"></div>`, `<button class="btn" data-action="close-modal">إلغاء</button><button class="btn primary" data-action="save-date">حفظ التاريخ</button>`);
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB unavailable"));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE, { keyPath: "id" }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Database error"));
    });
    return dbPromise;
  }
  async function getStoredBook(subjectId) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(subjectId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async function saveStoredBook(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Storage quota"));
    });
  }
  async function deleteStoredBook(subjectId) {
    try {
      const db = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(DB_STORE, "readwrite");
        transaction.objectStore(DB_STORE).delete(subjectId);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    } catch { /* no book is stored */ }
    if (activePdfUrls.has(subjectId)) URL.revokeObjectURL(activePdfUrls.get(subjectId));
    activePdfUrls.delete(subjectId);
    delete state.bookMeta[subjectId];
    saveState();
    toast("تمت إزالة ملف الكتاب من المتصفح.");
    renderPage();
  }
  async function attachBook(subjectId) {
    try {
      const record = await getStoredBook(subjectId);
      if (record?.blob) {
        if (activePdfUrls.has(subjectId)) URL.revokeObjectURL(activePdfUrls.get(subjectId));
        activePdfUrls.set(subjectId, URL.createObjectURL(record.blob));
        toast("تم فتح الكتاب المحفوظ على هذا الجهاز.");
        if (selectedLesson) renderLesson(selectedSubject, selectedUnit, selectedLesson);
        else if (selectedUnit) renderUnit(selectedSubject, selectedUnit);
        else renderSubject(subjectId);
        return;
      }
    } catch { /* file picker below is still available */ }
    attachedBookSubject = subjectId;
    const input = $("#bookFileInput");
    input.value = "";
    input.click();
  }
  async function storeSelectedBook(file) {
    const subjectId = attachedBookSubject;
    if (!subjectId || !file) return;
    if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) { toast("اختر ملف PDF صالحًا."); return; }
    const tempUrl = URL.createObjectURL(file);
    if (activePdfUrls.has(subjectId)) URL.revokeObjectURL(activePdfUrls.get(subjectId));
    activePdfUrls.set(subjectId, tempUrl);
    const meta = { name: file.name, size: file.size, addedAt: new Date().toISOString() };
    try {
      await saveStoredBook({ id: subjectId, blob: file, name: file.name, size: file.size, addedAt: meta.addedAt });
      state.bookMeta[subjectId] = meta;
      saveState();
      toast("حُفظ ملف الكتاب في مساحة هذا المتصفح.");
    } catch {
      state.bookMeta[subjectId] = { ...meta, sessionOnly: true };
      saveState();
      toast("تعذّر حفظ الملف بعد إغلاق المتصفح؛ سيبقى متاحًا في هذه الجلسة.");
    }
    if (selectedLesson) renderLesson(selectedSubject, selectedUnit, selectedLesson);
    else if (selectedUnit) renderUnit(selectedSubject, selectedUnit);
    else renderSubject(subjectId);
  }

  function normalizeText(value) {
    return String(value).normalize("NFD").replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").toLowerCase().trim();
  }
  function searchableItems() {
    return [...lessonById.values()].map(lesson => ({ type: "lesson", id: lesson.id, title: lesson.title, detail: `${lesson.subjectName} · ${lesson.unitTitle}`, subject: lesson.subjectId, unit: lesson.unitId }));
  }
  function renderSearchResults(query) {
    const box = $("#searchResults");
    const value = normalizeText(query);
    if (!value) { box.classList.add("hidden"); return; }
    const found = searchableItems().filter(item => normalizeText(`${item.title} ${item.detail}`).includes(value)).slice(0, 8);
    box.innerHTML = found.length ? found.map(item => `<button class="search-result" data-action="search-open-lesson" data-id="${item.id}" role="option"><span class="result-icon">${subjectIcon(item.subject)}</span><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail)}</small></span></button>`).join("") : `<div class="search-empty">لا توجد نتيجة مطابقة لعناوين المواد المسجلة.</div>`;
    box.classList.remove("hidden");
  }

  function openQuestionReview(questionId) {
    const item = questions.find(question => question.id === questionId);
    if (!item) return;
    const body = `<div class="question-kicker"><span>${escapeHtml(item.lesson)}</span><span>تدريب غير وزاري</span></div><h3 style="font-size:14px;line-height:1.8">${escapeHtml(item.prompt)}</h3><div class="result-review-row correct"><b>الإجابة الصحيحة: ${escapeHtml(item.options[item.answer])}</b><span>${escapeHtml(item.explain)}</span></div>`;
    showModal("مراجعة سؤال", courseById.get(item.subject)?.name || "", body, `<button class="btn" data-action="close-modal">إغلاق</button><button class="btn primary" data-action="open-question-lesson" data-id="${item.id}">افتح الدرس المرتبط</button>`);
  }
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "riwaq-study-progress.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("تم تنزيل نسخة من تقدمك.");
  }
  function importData() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!parsed || typeof parsed !== "object") throw new Error("invalid");
          state = { ...defaultState(), ...parsed };
          saveState(); renderPage(); toast("تم استيراد تقدمك.");
        } catch { toast("تعذّر قراءة ملف التقدم."); }
      };
      reader.readAsText(file);
    };
    input.click();
  }
  function printLesson(lessonId) {
    const lesson = lessonById.get(lessonId);
    if (!lesson) return;
    const subject = courseById.get(lesson.subjectId);
    const unit = unitById.get(lesson.unitId);
    const printWindow = window.open("", "_blank", "width=900,height=720");
    if (!printWindow) { toast("اسمح بفتح نافذة الطباعة لهذا الموقع."); return; }
    printWindow.document.write(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>${escapeHtml(lesson.title)}</title><style>body{font:16px Tahoma,Arial,sans-serif;color:#22342c;line-height:1.9;max-width:780px;margin:40px auto;padding:20px}h1{font-size:25px}h2{font-size:17px;margin-top:30px}p,li{font-size:14px;color:#43534c}.box{padding:15px;border:1px solid #dce7df;border-radius:12px;background:#f6faf7}@media print{body{margin:15mm}}</style><body><small>${escapeHtml(subject.name)} · ${escapeHtml(unit.title)}</small><h1>${escapeHtml(lesson.title)}</h1><div class="box"><b>مرجع الكتاب</b><p>${escapeHtml(subject.bookNote)} · الصفحة المطبوعة ${lesson.page}</p></div><h2>نقاط المراجعة</h2><ul><li>اقرأ التعريف أو الفكرة الأساسية في المصدر.</li><li>دوّن العلاقة أو المثال الوارد في الدرس.</li><li>أعد حل سؤال من أنشطة الكتاب ثم تحقق من الإجابة.</li></ul><h2>ملاحظاتي</h2><p>__________________________________________________________________</p><p>__________________________________________________________________</p><p>__________________________________________________________________</p></body></html>`);
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 350);
  }

  function handleAction(action, id, button) {
    const lesson = lessonById.get(id);
    switch (action) {
      case "open-subjects": navTo("subjects"); break;
      case "open-planner": navTo("planner"); break;
      case "open-settings": navTo("settings"); break;
      case "open-resources": navTo("resources"); break;
      case "open-subject": activePage = "subjects"; $$(".nav-item[data-nav]").forEach(item => item.classList.toggle("active", item.dataset.nav === "subjects")); renderSubject(id); break;
      case "subject-filter": subjectFilter = id; renderSubjects(); break;
      case "open-unit": renderUnit(selectedSubject, id); break;
      case "open-lesson": case "search-open-lesson": openLessonById(id); $("#searchResults").classList.add("hidden"); break;
      case "back-subject": renderSubject(id); break;
      case "back-unit": if (lesson) renderUnit(lesson.subjectId, lesson.unitId); else renderUnit(selectedSubject, selectedUnit); break;
      case "toggle-done":
        state.completed = state.completed.includes(id) ? state.completed.filter(item => item !== id) : [...state.completed, id]; saveState();
        if (selectedLesson) renderLesson(selectedSubject, selectedUnit, selectedLesson); else renderPage();
        toast(state.completed.includes(id) ? "تم تسجيل الدرس كمُراجع." : "أُزيلت علامة المراجعة."); break;
      case "toggle-favorite": state.favorites = state.favorites.includes(id) ? state.favorites.filter(item => item !== id) : [...state.favorites, id]; saveState(); renderLesson(selectedSubject, selectedUnit, selectedLesson); toast(state.favorites.includes(id) ? "أُضيف الدرس إلى المفضلة." : "أُزيل الدرس من المفضلة."); break;
      case "lesson-tab": lessonTab = id; renderLesson(selectedSubject, selectedUnit, selectedLesson); break;
      case "print-lesson": printLesson(id); break;
      case "start-random-quiz": navTo("exams"); break;
      case "start-unit-quiz": startGuideAssessment("unit", id); break;
      case "start-lesson-quiz": startQuiz({ lessonId: id }, "all", 0); break;
      case "start-lesson-test": startGuideAssessment("lesson", id); break;
      case "start-subject-final": startGuideAssessment("final", id); break;
      case "rate-self-answer": {
        if (!assessmentState) break;
        const index = Number(id);
        assessmentState.ratings[index] = button.dataset.value === "right";
        const group = $("[data-rating-for=\"" + index + "\"]");
        group?.querySelectorAll("[data-action=\"rate-self-answer\"]").forEach(item => item.classList.toggle("soft", assessmentState.ratings[index] === (item.dataset.value === "right")));
        break;
      }
      case "finish-self-assessment": finishSelfAssessment(); break;
      case "retake-self-assessment":
        if (assessmentState) { assessmentState.answers = {}; assessmentState.ratings = {}; renderSelfAssessment(); }
        break;
      case "cancel-self-assessment": {
        const subjectId = assessmentState?.subjectId;
        assessmentState = null;
        if (subjectId) {
          activePage = "subjects";
          $$(".nav-item[data-nav]").forEach(item => item.classList.toggle("active", item.dataset.nav === "subjects"));
          renderSubject(subjectId);
        } else navTo("subjects");
        break;
      }
      case "start-mistake-quiz": startQuiz({ ids: state.mistakes.slice() }, "all", 0); break;
      case "submit-quiz-setup": {
        const subjectId = $("#quizSubject")?.value;
        const unitId = $("#quizUnit")?.value;
        const count = $("#quizCount")?.value || "5";
        const minutes = $("#quizTimer")?.value || "0";
        startQuiz({ ...(subjectId && subjectId !== "all" ? { subjectId } : {}), ...(unitId && unitId !== "all" ? { unitId } : {}) }, count, minutes); break;
      }
      case "choose-answer": if (quizState) { quizState.answers[quizState.questions[quizState.index].id] = Number(id); renderQuiz(); } break;
      case "next-question": if (quizState && quizState.index < quizState.questions.length - 1) { quizState.index++; renderQuiz(); } break;
      case "previous-question": if (quizState && quizState.index > 0) { quizState.index--; renderQuiz(); } break;
      case "finish-quiz": finishQuiz(); break;
      case "retake-quiz": if (window.lastQuizResult) startQuiz(window.lastQuizResult.filter, window.lastQuizResult.questions.length, 0); else navTo("exams"); break;
      case "back-to-quiz-source": navTo("exams"); break;
      case "open-mistakes": navTo("revision"); break;
      case "open-attempt-mistakes": navTo("revision"); break;
      case "open-question-review": openQuestionReview(id); break;
      case "open-question-lesson": {
        const item = questions.find(question => question.id === id);
        closeModal();
        if (item) {
          const matching = [...lessonById.values()].find(one => one.subjectId === item.subject && one.unitId === item.unit && one.title === item.lesson) || [...lessonById.values()].find(one => one.subjectId === item.subject && one.unitId === item.unit && normalizeText(one.title).includes(normalizeText(item.lesson)));
          if (matching) openLessonById(matching.id);
        }
        break;
      }
      case "flip-card": flashFlipped = !flashFlipped; renderFlashcards(); break;
      case "next-card": flashIndex = (flashIndex + 1) % terms.length; flashFlipped = false; renderFlashcards(); break;
      case "previous-card": flashIndex = (flashIndex - 1 + terms.length) % terms.length; flashFlipped = false; renderFlashcards(); break;
      case "shuffle-cards": flashIndex = Math.floor(Math.random() * terms.length); flashFlipped = false; renderFlashcards(); break;
      case "set-exam-date": setExamDateModal(); break;
      case "save-date": state.examDate = $("#dateEdit")?.value || ""; saveState(); closeModal(); renderPage(); toast("تم حفظ موعد الاختبار."); break;
      case "save-name": state.name = $("#nameEdit")?.value.trim() || ""; syncProfileName(state.name); saveState(); closeModal(); renderPage(); break;
      case "change-grade": window.RIWAQ_AUTH?.showProfileSwitcher(); break;
      case "sign-out": window.RIWAQ_AUTH?.signOut(); break;
      case "close-modal": closeModal(); break;
      case "attach-book": attachBook(id); break;
      case "clear-book": deleteStoredBook(id); break;
      case "export-data": exportData(); break;
      case "import-data": importData(); break;
      case "reset-data": showModal("مسح بيانات التقدم", "سيُحذف التقدم والمهام والنتائج المحفوظة في هذا المتصفح.", `<p class="muted">لا يمكن التراجع بعد المسح. ملفات الكتب المحفوظة ستبقى منفصلة.</p>`, `<button class="btn" data-action="close-modal">إلغاء</button><button class="btn danger" data-action="confirm-reset">مسح البيانات</button>`); break;
      case "confirm-reset": state = defaultState(); saveState(); closeModal(); renderPage(); toast("تم مسح بيانات التقدم."); break;
      case "delete-task": state.tasks = state.tasks.filter(task => task.id !== id); saveState(); renderPlanner(); break;
      case "save-schedule": $$("[data-schedule-day]").forEach(select => { if (select.value) state.schedule[select.dataset.scheduleDay] = select.value; else delete state.schedule[select.dataset.scheduleDay]; }); saveState(); toast("تم حفظ جدول الأسبوع."); renderPlanner(); break;
    }
  }

  function handleClick(event) {
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    const id = actionButton.dataset.id;
    handleAction(action, id, actionButton);
  }
  function onTaskToggle(event) {
    const toggle = event.target.closest("[data-task-toggle]");
    if (!toggle) return;
    const task = state.tasks.find(item => item.id === toggle.dataset.taskToggle);
    if (task) { task.done = toggle.checked; saveState(); renderPage(); }
  }
  function onSubmit(event) {
    if (event.target.id === "taskForm") {
      event.preventDefault();
      const values = new FormData(event.target);
      const title = String(values.get("title") || "").trim();
      if (!title) return;
      state.tasks.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), title, due: values.get("due") || "", done: false });
      saveState(); renderPlanner(); toast("أُضيفت المهمة إلى خطتك.");
    }
    if (event.target.id === "settingsForm") {
      event.preventDefault();
      const values = new FormData(event.target);
      state.name = String(values.get("name") || "").trim();
      syncProfileName(state.name);
      state.examDate = String(values.get("examDate") || "");
      saveState(); renderSettings(); toast("تم حفظ الإعدادات.");
    }
    if (event.target.id === "assistantForm") {
      event.preventDefault();
      const values = new FormData(event.target);
      const query = String(values.get("query") || "").trim();
      const needle = normalizeText(query);
      const matches = [...lessonById.values()].filter(lesson => normalizeText(`${lesson.title} ${lesson.unitTitle} ${lesson.subjectName}`).split(/\s+/).some(word => word.length > 2 && needle.includes(word)) || needle.includes(normalizeText(lesson.title)));
      const termMatches = terms.filter(term => needle.includes(normalizeText(term.term)) || normalizeText(term.term).includes(needle));
      const response = $("#assistantResponse");
      if (!matches.length && !termMatches.length) response.innerHTML = `لم أجد عنوانًا مطابقًا في خريطة المنهج المتاحة. جرّب كلمة من عنوان الدرس، أو افتح المادة واقرأ كتاب المصدر. لا أستنتج إجابة من ملف لم أتمكن من فهرسته.`;
      else response.innerHTML = `<b>وجدت مواضع قريبة في الخريطة:</b><div class="assistant-matches">${matches.slice(0, 6).map(lesson => `<button class="assistant-match" data-action="open-lesson" data-id="${lesson.id}"><b>${escapeHtml(lesson.title)}</b><small>${escapeHtml(lesson.subjectName)} · ${escapeHtml(lesson.unitTitle)} · ص ${lesson.page}</small></button>`).join("")}${termMatches.map(term => `<div class="assistant-match"><b>${escapeHtml(term.term)}</b><small>${escapeHtml(term.meaning)}</small></div>`).join("")}</div>`;
    }
  }
  function handleChange(event) {
    if (event.target.id === "bookFileInput") storeSelectedBook(event.target.files?.[0]);
    if (event.target.id === "reminderSwitch") { state.reminder = event.target.checked; saveState(); }
    if (event.target.id === "darkSwitch") { state.theme = event.target.checked ? "dark" : "light"; document.body.classList.toggle("dark", state.theme === "dark"); saveState(); }
    if (event.target.matches("[data-task-toggle]")) onTaskToggle(event);
    if (event.target.id === "quizSubject") updateQuizUnitOptions();
  }
  function closeSidebar() {
    $("#sidebar").classList.remove("open");
    $("#mobileOverlay").classList.remove("show");
  }
  function init() {
    document.body.classList.toggle("dark", state.theme === "dark");
    $(".nav-list").addEventListener("click", event => {
      const item = event.target.closest("[data-nav]");
      if (item) navTo(item.dataset.nav);
    });
    $(".sidebar").addEventListener("click", event => {
      const item = event.target.closest("[data-nav]");
      if (item) navTo(item.dataset.nav);
    });
    $("#pageContent").addEventListener("click", handleClick);
    $("#pageContent").addEventListener("input", event => {
      const field = event.target.closest("[data-assessment-answer]");
      if (field && assessmentState) assessmentState.answers[field.dataset.assessmentAnswer] = field.value;
    });
    $("#modal").addEventListener("click", handleClick);
    $("#modalBackdrop").addEventListener("click", event => { if (event.target.id === "modalBackdrop") closeModal(); });
    $("#pageContent").addEventListener("change", handleChange);
    $("#pageContent").addEventListener("change", onTaskToggle);
    $("#pageContent").addEventListener("submit", onSubmit);
    $("#bookFileInput").addEventListener("change", handleChange);
    $("#themeToggle").addEventListener("click", () => { state.theme = state.theme === "dark" ? "light" : "dark"; document.body.classList.toggle("dark", state.theme === "dark"); saveState(); });
    $("#profileButton").addEventListener("click", openNameModal);
    $("#notificationButton").addEventListener("click", () => navTo("planner"));
    $("#mobileMenu").addEventListener("click", () => { $("#sidebar").classList.toggle("open"); $("#mobileOverlay").classList.toggle("show"); });
    $("#mobileOverlay").addEventListener("click", closeSidebar);
    $("#globalSearch").addEventListener("input", event => renderSearchResults(event.target.value));
    $("#globalSearch").addEventListener("keydown", event => { if (event.key === "Enter") { const first = $("#searchResults [data-action]"); if (first) first.click(); } });
    document.addEventListener("click", event => { if (!event.target.closest(".search-box") && !event.target.closest("#searchResults")) $("#searchResults").classList.add("hidden"); });
    document.addEventListener("keydown", event => {
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { event.preventDefault(); $("#globalSearch").focus(); }
      if (event.key === "Escape") { closeModal(); closeSidebar(); $("#searchResults").classList.add("hidden"); }
    });
    window.addEventListener("beforeunload", () => activePdfUrls.forEach(url => URL.revokeObjectURL(url)));
    renderPage();
  }
  init();
})();
