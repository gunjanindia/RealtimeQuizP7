const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const QRCode = require("qrcode");
const { Redis } = require("@upstash/redis");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_FILE = path.join(__dirname, "quiz-config.json");
const ADMIN_PASSWORD = process.env.QUIZ_ADMIN_PASSWORD || "admin123";
const redisUrl =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const redisToken =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

let redis = null;
if (redisUrl && redisToken) {
  try {
    redis = new Redis({ url: redisUrl, token: redisToken });
  } catch (error) {
    console.error("Failed to connect to Upstash Redis:", error.message);
  }
} else if (redisUrl || redisToken) {
  console.warn("Only one of Upstash Redis REST URL or token was provided. Falling back to in-memory state.");
} else if (process.env.VERCEL) {
  console.warn(
    "Running on Vercel without Upstash Redis credentials. Using in-memory state fallback. " +
    "For multi-instance state sync across serverless invocations, please add " +
    "UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, and QUIZ_ADMIN_PASSWORD in Vercel Project Settings."
  );
}

const REDIS_STATE_KEY = "realtime-quiz:state";
const REDIS_LOCK_KEY = "realtime-quiz:state-lock";

let quizMeta = {
  quizTitle: "Presentation 3 — Cyber Fraud & the Money Trail: Quiz",
  quizSubtitle: "Law as on October 2026 · Reader v7 (110 slides) · 2 Case Studies + 12 Direct Questions · 18 Questions",
  timeMinutes: 10,
};

function applyConfigMeta(config) {
  if (!config || typeof config !== "object") return;
  if (config.quiz) quizMeta.quizTitle = config.quiz;
  if (config.time_minutes) quizMeta.timeMinutes = Number(config.time_minutes) || 10;
  if (config.structure || config.deck_version || config.law_as_on) {
    const parts = [];
    if (config.law_as_on) parts.push(`Law as on ${config.law_as_on}`);
    if (config.deck_version) parts.push(config.deck_version);
    if (config.structure) parts.push(config.structure);
    quizMeta.quizSubtitle = parts.join(" · ");
  }
}

function extractQuestions(config) {
  if (!config || typeof config !== "object") return [];
  if (Array.isArray(config.questions) && config.questions.length > 0) {
    return config.questions;
  }
  if (Array.isArray(config.scenarios) && config.scenarios.length > 0) {
    const list = [];
    let qId = 1;
    for (const sc of config.scenarios) {
      if (Array.isArray(sc.questions)) {
        for (const q of sc.questions) {
          const letterIndex = ["A", "B", "C", "D"].indexOf(String(q.answer || "").trim().toUpperCase());
          const correct = typeof q.correct === "number" ? q.correct : (letterIndex >= 0 ? letterIndex : 0);
          list.push({
            id: q.id || qId++,
            scenarioId: sc.id,
            section: sc.section || (sc.id === 3 ? "direct" : "case"),
            scenarioTitle: sc.title || `Scenario ${sc.id}`,
            scenarioText: sc.scenario || "",
            scenarioSource: sc.source || "",
            type: q.type || "apply",
            typeLabel: config.question_types?.[q.type] || (q.type ? q.type.charAt(0).toUpperCase() + q.type.slice(1) : "Apply"),
            prompt: q.prompt || q.question || "",
            options: q.options || [],
            correct,
            explanation: q.explanation || "",
            slides: Array.isArray(q.slides) ? q.slides : []
          });
        }
      }
    }
    return list;
  }
  return [];
}

const EMBEDDED_DEFAULT_QUESTIONS = [
  {
    id: 1,
    scenarioId: 1,
    section: "case",
    scenarioTitle: "Case study 1 — The refund that went elsewhere",
    scenarioText: "An NRI who has lived in the UK for nearly 50 years filed his return for FY 2023-24 and received his genuine refund. Fraudsters then took over his e-filing account, changed the registered e-mail, mobile number and bank account, and filed a revised return in his name. About ₹2.26 crore of further refund was paid into a fraudulent bank account and moved through several companies’ accounts, with a commission cut at each stage.",
    scenarioSource: "The Tribune, 14 July 2026 (Panchkula Cyber Crime Police)",
    type: "apply",
    typeLabel: "Apply",
    prompt: "At which point did the Department have its best chance to stop the money?",
    options: [
      "When the mobile, e-mail and bank account were changed just before a large refund on a revised return",
      "When the original return for FY 2023-24 was filed and the first, genuine refund was credited to his account",
      "When each company in the chain deducted its commission before passing the balance to the next account",
      "When the money finally left the last company’s account and was withdrawn in cash by the organisers"
    ],
    correct: 0,
    explanation: "A change of contact details and bank account followed quickly by a large revised-return refund is the red flag. Once the refund leaves, the money moves through layers within hours.",
    slides: [4, 6, 68]
  },
  {
    id: 2,
    scenarioId: 1,
    section: "case",
    scenarioTitle: "Case study 1 — The refund that went elsewhere",
    scenarioText: "An NRI who has lived in the UK for nearly 50 years filed his return for FY 2023-24 and received his genuine refund. Fraudsters then took over his e-filing account, changed the registered e-mail, mobile number and bank account, and filed a revised return in his name. About ₹2.26 crore of further refund was paid into a fraudulent bank account and moved through several companies’ accounts, with a commission cut at each stage.",
    scenarioSource: "The Tribune, 14 July 2026 (Panchkula Cyber Crime Police)",
    type: "law",
    typeLabel: "Law",
    prompt: "Taking over the NRI’s e-filing account and filing a return in his name is, at its core, which offence?",
    options: [
      "Disclosure of taxpayer information by a public servant — Section 494 of the Income-tax Act, 2025",
      "Identity theft and cheating by personation — Sections 66C and 66D IT Act, with cheating under the BNS",
      "Organised crime under Section 111 BNS alone, because the money passed through several companies",
      "No criminal offence, only a tax-recovery matter, because the refund was paid by the Department itself"
    ],
    correct: 1,
    explanation: "Using another person’s password or identity is Section 66C; cheating by impersonating him online is Section 66D, alongside cheating under Sections 318–319 BNS.",
    slides: [25, 74]
  },
  {
    id: 3,
    scenarioId: 1,
    section: "case",
    scenarioTitle: "Case study 1 — The refund that went elsewhere",
    scenarioText: "An NRI who has lived in the UK for nearly 50 years filed his return for FY 2023-24 and received his genuine refund. Fraudsters then took over his e-filing account, changed the registered e-mail, mobile number and bank account, and filed a revised return in his name. About ₹2.26 crore of further refund was paid into a fraudulent bank account and moved through several companies’ accounts, with a commission cut at each stage.",
    scenarioSource: "The Tribune, 14 July 2026 (Panchkula Cyber Crime Police)",
    type: "evidence",
    typeLabel: "Evidence",
    prompt: "Which record would most directly show who took over the e-filing account?",
    options: [
      "The NRI’s original return for FY 2023-24 and the refund order issued on it, read with his bank statement",
      "The NRI’s Annual Information Statement, which lists every refund and payment made against his PAN",
      "The e-filing portal’s logs — login IPs and times, OTPs, and changes to e-mail, mobile and bank",
      "Form 26AS of the companies through which the money passed, showing the tax deducted on each payment"
    ],
    correct: 2,
    explanation: "The portal’s logs show when and from where the details were changed; the IP and exact time lead to the subscriber, and the new bank account’s KYC to its holder. Electronic records need a Section 63 BSA certificate.",
    slides: [47, 55]
  },
  {
    id: 4,
    scenarioId: 2,
    section: "case",
    scenarioTitle: "Case study 2 — The security guard’s ₹3.91 crore demand",
    scenarioText: "A contractual security guard with no taxable income was assessed for AY 2017-18 on about ₹49.49 crore of cash payments and cash sales shown against his PAN on the portal. The Assessing Officer taxed 8% as income and raised a demand of about ₹3.91 crore, relying only on the portal data. The guard said his PAN had been misused and had complained to the police. The Delhi High Court quashed the assessment.",
    scenarioSource: "Delhi High Court, Lalit v. Union of India, W.P.(C) 9365/2025 (LiveLaw, 14 October 2026)",
    type: "apply",
    typeLabel: "Apply",
    prompt: "In the session’s terms, what does this profile most suggest?",
    options: [
      "A misused or rented identity — the PAN leads to a front man, not to the person who gained",
      "A large hidden business run by the guard himself, using his job as a cover for cash trading",
      "A simple data-entry error by the reporting company, which needs no further inquiry by the AO",
      "A routine case of under-reported GST turnover, to be referred to the GST authorities at once"
    ],
    correct: 0,
    explanation: "A low-income person shown with crores of transactions is the classic mule or identity-misuse profile. A PAN on a record shows it was quoted, not who used it.",
    slides: [34, 41]
  },
  {
    id: 5,
    scenarioId: 2,
    section: "case",
    scenarioTitle: "Case study 2 — The security guard’s ₹3.91 crore demand",
    scenarioText: "A contractual security guard with no taxable income was assessed for AY 2017-18 on about ₹49.49 crore of cash payments and cash sales shown against his PAN on the portal. The Assessing Officer taxed 8% as income and raised a demand of about ₹3.91 crore, relying only on the portal data. The guard said his PAN had been misused and had complained to the police. The Delhi High Court quashed the assessment.",
    scenarioSource: "Delhi High Court, Lalit v. Union of India, W.P.(C) 9365/2025 (LiveLaw, 14 October 2026)",
    type: "law",
    typeLabel: "Law",
    prompt: "Which power should the AO have used to test the portal data before assessing?",
    options: [
      "A notice to the guard’s bank under Section 94 BNSS [old Section 91 CrPC] for his account statements",
      "Referring the case to the police under Section 258 [old Section 138] and waiting for the FIR’s outcome",
      "A search and seizure at the guard’s home as the very first step of the inquiry into the transactions",
      "Calling for information from the company — Section 133(6) of the 1961 Act [now Section 252, 2025 Act]"
    ],
    correct: 3,
    explanation: "The Court said the AO should have made further inquiries, including under Section 133(6). Section 94 BNSS is a police power, not available to a tax officer.",
    slides: [36, 41, 59]
  },
  {
    id: 6,
    scenarioId: 2,
    section: "case",
    scenarioTitle: "Case study 2 — The security guard’s ₹3.91 crore demand",
    scenarioText: "A contractual security guard with no taxable income was assessed for AY 2017-18 on about ₹49.49 crore of cash payments and cash sales shown against his PAN on the portal. The Assessing Officer taxed 8% as income and raised a demand of about ₹3.91 crore, relying only on the portal data. The guard said his PAN had been misused and had complained to the police. The Delhi High Court quashed the assessment.",
    scenarioSource: "Delhi High Court, Lalit v. Union of India, W.P.(C) 9365/2025 (LiveLaw, 14 October 2026)",
    type: "precaution",
    typeLabel: "Precaution",
    prompt: "Which error did the Court find in the assessment?",
    options: [
      "It taxed only 8% as income, when the whole ₹49.49 crore should have been added as unexplained money",
      "It was made under the 1961 Act, when it should have been made under the Income-tax Act, 2025",
      "It relied only on portal data, withheld the material relied on and ignored the PAN-misuse claim",
      "It was made before the guard had been prosecuted for the transactions recorded under his PAN"
    ],
    correct: 2,
    explanation: "The Court found a breach of natural justice and no independent evidence linking him to the transactions.",
    slides: [41]
  },
  {
    id: 7,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "apply",
    typeLabel: "Apply",
    prompt: "In a phishing APK fraud, why does the fake app ask the victim for the OTP?",
    options: [
      "So that the bank can confirm the victim’s updated KYC before the deadline",
      "So that the APK file can be unlocked and installed on the victim’s phone",
      "So that the victim’s PAN can be verified with the Income Tax Department",
      "So that the criminal can register the victim’s bank account on his own phone"
    ],
    correct: 3,
    explanation: "The criminal installs the real bank app with the victim’s mobile number; the OTP typed into the fake app reaches his dashboard and ties his handset to the victim’s account.",
    slides: [9]
  },
  {
    id: 8,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "apply",
    typeLabel: "Apply",
    prompt: "A fraud payment went to a UPI ID ending in ‘@oksbi’. What does the part after ‘@’ tell you?",
    options: [
      "The bank and branch where the receiving account is actually held",
      "The app’s partner (PSP) bank — not necessarily the bank holding the account",
      "The State in which the account holder lives and opened the account",
      "The telecom operator of the mobile number linked to the account"
    ],
    correct: 1,
    explanation: "The handle shows the payment app’s partner bank. Ask that bank or NPCI, with the RRN, which bank holds the account.",
    slides: [46]
  },
  {
    id: 9,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "evidence",
    typeLabel: "Evidence",
    prompt: "Which of these will a tax officer NOT see in SFT or AIS data?",
    options: [
      "Cash deposits of ₹10 lakh or more in a year in a savings account",
      "Time deposits above the reporting limit made during the year",
      "Credit-card bill payments above the limit made during the year",
      "Thousands of small UPI credits into a mule’s savings account"
    ],
    correct: 3,
    explanation: "SFT covers large cash deposits, time deposits and card bills — not UPI or IMPS credits. That is why tax data maps mule networks only later.",
    slides: [35]
  },
  {
    id: 10,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "law",
    typeLabel: "Law",
    prompt: "Which power lets an Assessing Officer call for a bank’s or platform’s records on a suspect account?",
    options: [
      "Section 94 BNSS [old Section 91 CrPC], read with Section 168",
      "Section 106 BNSS [old Section 102 CrPC], seizure of property",
      "Section 79 of the IT Act, read with the IT Rules, 2021",
      "Section 252 of the Income-tax Act, 2025 [old Section 133(6)]"
    ],
    correct: 3,
    explanation: "Section 252 is the Department’s own power. Sections 94 and 106 BNSS are police powers; Section 79 IT Act is the intermediaries’ safe harbour.",
    slides: [36, 59]
  },
  {
    id: 11,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "evidence",
    typeLabel: "Evidence",
    prompt: "A large transaction appears against a PAN in portal data. On its own, what does that prove?",
    options: [
      "That the PAN holder personally made the transaction",
      "That the PAN holder earned and kept the money",
      "Only that the PAN was quoted for the transaction",
      "That the PAN holder knowingly lent his account"
    ],
    correct: 2,
    explanation: "A PAN, phone number or IP is an identity, not a person. Independent evidence — counterparty records, KYC, logins — must link the person to the transaction (Lalit v. UoI).",
    slides: [39, 41]
  },
  {
    id: 12,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "law",
    typeLabel: "Law",
    prompt: "When must a Section 63 BSA [old Section 65B IEA] certificate accompany an electronic record?",
    options: [
      "Every time the computer output is tendered in evidence",
      "Only when the other side disputes the record in court",
      "Only for records obtained from platforms based abroad",
      "Only when the original device has been lost or destroyed"
    ],
    correct: 0,
    explanation: "Section 63(4) requires the certificate each time; the Supreme Court upheld it in Pune Bar Association v. UoI (22 May 2026).",
    slides: [54, 55]
  },
  {
    id: 13,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "evidence",
    typeLabel: "Evidence",
    prompt: "Why is the hash value of seized data recorded at the time of seizure?",
    options: [
      "To show later that the data has not changed since it was seized",
      "To encrypt the data so that the accused can no longer read it",
      "To compress the data so that it fits on the evidence drive",
      "To identify the owner of the device from which it was taken"
    ],
    correct: 0,
    explanation: "A hash is an ‘electronic fingerprint’: any change in the data changes it. A matching hash at trial proves integrity.",
    slides: [53, 55]
  },
  {
    id: 14,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "law",
    typeLabel: "Law",
    prompt: "In a search, a cloud account is locked and the person will not give the password. What does the Income-tax Act, 2025 allow?",
    options: [
      "Nothing — virtual digital space lies outside the scope of a search under the Act",
      "The authorised officer may gain access by overriding the access code (Section 247)",
      "The officer must first obtain a Magistrate’s warrant under Section 94 BNSS",
      "Only the police may open it, after registering an FIR under the IT Act"
    ],
    correct: 1,
    explanation: "Section 247(1)(b)(iii) [old 132(1)(iib)] allows access by overriding the access code where it is not available; Section 261(j) defines virtual digital space.",
    slides: [53]
  },
  {
    id: 15,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "law",
    typeLabel: "Law",
    prompt: "Under the MHA SOP of 2 January 2026, ₹30,000 of one victim is on hold and is not needed for investigation. Who may release it?",
    options: [
      "Only a Magistrate, under Section 503 BNSS [old Section 457 CrPC], after an FIR",
      "The bank on its own, as soon as the victim gives it a written request",
      "The police, under Section 106(3) BNSS, with SP/DCP approval and an indemnity bond",
      "The RBI Ombudsman, on a complaint filed by the victim against the bank"
    ],
    correct: 2,
    explanation: "For a single victim and an amount below ₹50,000, the SOP allows police release after notice to the account holder, approval and an indemnity bond, with a report to the court.",
    slides: [69, 70]
  },
  {
    id: 16,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "law",
    typeLabel: "Law",
    prompt: "What does the new Section 107 BNSS add for victims of cyber fraud?",
    options: [
      "The Magistrate may attach proceeds and share them rateably among victims",
      "Police may freeze any account without reporting the freeze to a Magistrate",
      "Banks must refund every victim within seven days of the complaint",
      "Victims may attach the accused’s house without going to a court"
    ],
    correct: 0,
    explanation: "Section 107 provides for attachment with a Magistrate’s order; Section 107(6) allows rateable distribution among victims through the District Magistrate.",
    slides: [69, 70]
  },
  {
    id: 17,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "precaution",
    typeLabel: "Precaution",
    prompt: "A bank’s weak security leads to a customer-data leak. Under the DPDP Act, who faces the penalty, and from when?",
    options: [
      "The employee who leaked it — from 14 November 2025",
      "The bank’s directors personally — from 1 July 2024",
      "No one — the Act has no penalty for such a leak",
      "The bank, as data fiduciary — from 14 May 2027"
    ],
    correct: 3,
    explanation: "Penalties (up to ₹250 crore for failing to take security safeguards) fall on the data fiduciary; most duties and penalties apply from 14 May 2027. Individuals are reached under Section 72A IT Act and the BNS.",
    slides: [74, 75]
  },
  {
    id: 18,
    scenarioId: 3,
    section: "direct",
    scenarioTitle: "Direct questions",
    scenarioText: "",
    scenarioSource: "",
    type: "precaution",
    typeLabel: "Precaution",
    prompt: "Fraud money parked in USDT in a mule’s wallet is, for tax purposes, best treated as…",
    options: [
      "A VDA gain taxed at a flat 30% under Section 194",
      "Unexplained money, not a gain on a virtual digital asset",
      "Exempt income, since crypto is not legal tender in India",
      "Business income of the exchange that holds the wallet"
    ],
    correct: 1,
    explanation: "The 30% rule taxes gains on VDAs. Fraud proceeds merely held in USDT are unexplained money.",
    slides: [83]
  }
];

let defaultQuestions = [...EMBEDDED_DEFAULT_QUESTIONS];
try {
  const bundledConfig = require("./quiz-config.json");
  applyConfigMeta(bundledConfig);
  const extracted = extractQuestions(bundledConfig);
  if (extracted.length > 0) {
    defaultQuestions = extracted;
  }
} catch {
  try {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    applyConfigMeta(savedConfig);
    const extracted = extractQuestions(savedConfig);
    if (extracted.length > 0) {
      defaultQuestions = extracted;
    }
  } catch {}
}

const MAX_QUESTIONS = 100;
const OPTION_COUNT = 4;

function normalizeQuestions(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) {
    throw new Error(`A quiz must contain between 1 and ${MAX_QUESTIONS} questions.`);
  }
  return value.map((question, index) => {
    if (!question || typeof question !== "object") {
      throw new Error(`Question ${index + 1} is invalid.`);
    }
    const prompt = typeof question.prompt === "string" ? question.prompt.trim() : (typeof question.question === "string" ? question.question.trim() : "");
    const options = Array.isArray(question.options)
      ? question.options.map((option) => (typeof option === "string" ? option.trim() : ""))
      : [];
    if (!prompt || prompt.length > 2000) {
      throw new Error(`Question ${index + 1} must have a prompt of 1 to 2000 characters.`);
    }
    if (
      options.length !== OPTION_COUNT ||
      options.some((option) => !option || option.length > 500)
    ) {
      throw new Error(`Question ${index + 1} must have four answers of 1 to 500 characters each.`);
    }
    let correct = question.correct;
    if (!Number.isInteger(correct) && typeof question.answer === "string") {
      const idx = ["A", "B", "C", "D"].indexOf(question.answer.trim().toUpperCase());
      if (idx >= 0) correct = idx;
    }
    if (!Number.isInteger(correct) || correct < 0 || correct >= OPTION_COUNT) {
      throw new Error(`Question ${index + 1} must have one correct answer selected.`);
    }
    const scenarioId = Number.isInteger(question.scenarioId)
      ? question.scenarioId
      : Math.floor(index / 4) + 1;
    const type = typeof question.type === "string" ? question.type.trim() : "apply";
    const typeLabel = typeof question.typeLabel === "string" && question.typeLabel.trim()
      ? question.typeLabel.trim()
      : (type.charAt(0).toUpperCase() + type.slice(1));

    return {
      id: question.id || index + 1,
      scenarioId,
      section: question.section || (scenarioId === 3 ? "direct" : "case"),
      scenarioTitle: typeof question.scenarioTitle === "string" ? question.scenarioTitle.trim() : `Scenario ${scenarioId}`,
      scenarioText: typeof question.scenarioText === "string" ? question.scenarioText.trim() : (typeof question.scenario === "string" ? question.scenario.trim() : ""),
      scenarioSource: typeof question.scenarioSource === "string" ? question.scenarioSource.trim() : (typeof question.source === "string" ? question.source.trim() : ""),
      type,
      typeLabel,
      prompt,
      options,
      correct,
      explanation: typeof question.explanation === "string" ? question.explanation.trim() : "",
      slides: Array.isArray(question.slides) ? question.slides.filter(Number.isInteger) : []
    };
  });
}

const participants = new Map();
const adminSessions = new Set();
let questions = defaultQuestions.map((question) => ({ ...question, options: [...question.options] }));
let phase = "lobby";
let startedAt = null;
let roundId = 1;
let sharedRequestQueue = Promise.resolve();
let configuredJoinUrl = process.env.QUIZ_PUBLIC_URL
  ? normalizeJoinUrl(process.env.QUIZ_PUBLIC_URL)
  : null;

if (!redis) {
  try {
    let savedConfig = null;
    try {
      savedConfig = require("./quiz-config.json");
    } catch {
      savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
    if (savedConfig) {
      applyConfigMeta(savedConfig);
      if (savedConfig.joinUrl !== undefined) {
        if (typeof savedConfig.joinUrl === "string") {
          configuredJoinUrl = configuredJoinUrl || normalizeJoinUrl(savedConfig.joinUrl);
        }
      }
      const extracted = extractQuestions(savedConfig);
      if (extracted.length > 0) {
        questions = normalizeQuestions(extracted);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read quiz configuration: ${error.message}`);
    }
  }
}
try {
  questions = normalizeQuestions(questions);
} catch (err) {
  console.warn("Could not normalize questions, using defaults:", err.message);
  questions = normalizeQuestions(defaultQuestions);
}
const initialJoinUrl = configuredJoinUrl;

async function acquireStateLock() {
  const lockToken = crypto.randomBytes(24).toString("hex");
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const acquired = await redis.set(REDIS_LOCK_KEY, lockToken, { nx: true, px: 10_000 });
    if (acquired === "OK") return lockToken;
    const jitter = 25 + Math.floor(Math.random() * 35);
    await new Promise((resolve) => setTimeout(resolve, jitter));
  }
  throw new Error("Quiz state is busy. Please retry the request.");
}

async function releaseStateLock(lockToken) {
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    [REDIS_LOCK_KEY],
    [lockToken],
  );
}

async function loadSharedState() {
  const stored = await redis.get(REDIS_STATE_KEY);
  if (stored === null) {
    participants.clear();
    adminSessions.clear();
    phase = "lobby";
    startedAt = null;
    roundId = 1;
    configuredJoinUrl = initialJoinUrl;
    questions = normalizeQuestions(defaultQuestions);
    return;
  }
  const state = typeof stored === "string" ? JSON.parse(stored) : stored;
  if (
    !state ||
    !Array.isArray(state.participants) ||
    !Array.isArray(state.adminSessions) ||
    !["lobby", "live", "ended"].includes(state.phase) ||
    !Number.isSafeInteger(state.roundId)
  ) {
    throw new Error("Stored quiz state is invalid. Check the configured Upstash Redis database.");
  }
  participants.clear();
  for (const participant of state.participants) {
    participants.set(participant.id, participant);
  }
  adminSessions.clear();
  for (const token of state.adminSessions) {
    adminSessions.add(token);
  }
  phase = state.phase;
  startedAt = state.startedAt;
  roundId = state.roundId;
  if (
    state.version !== "2.0" ||
    !Array.isArray(state.questions) ||
    state.questions.length !== defaultQuestions.length
  ) {
    questions = normalizeQuestions(defaultQuestions);
    participants.clear();
    phase = "lobby";
    startedAt = null;
  } else {
    questions = normalizeQuestions(state.questions);
  }
}

async function saveSharedState() {
  await redis.set(
    REDIS_STATE_KEY,
    JSON.stringify({
      version: "2.0",
      phase,
      startedAt,
      roundId,
      configuredJoinUrl,
      questions,
      participants: [...participants.values()],
      adminSessions: [...adminSessions],
    }),
  );
}

function json(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    const timeout = setTimeout(() => {
      reject(new Error("Request timed out reading body"));
      request.destroy();
    }, 10000);
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16_384) {
        clearTimeout(timeout);
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function getScore(participant) {
  return participant.answers.reduce(
    (score, answer, index) =>
      score + (answer === null ? 0 : answer === questions[index].correct ? 1 : 0),
    0,
  );
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function formatDuration(milliseconds) {
  const totalSeconds = milliseconds / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(3).padStart(6, "0");
  return `${minutes}:${seconds}`;
}

function getState(participantId, isAdmin = false, request) {
  const leaderboard = [...participants.values()]
    .filter((participant) => participant.completedAt !== null)
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      score: getScore(participant),
      completedAt: participant.completedAt,
    }))
    .sort((a, b) => b.score - a.score || a.completedAt - b.completedAt)
    .map(({ completedAt, ...participant }, index) => ({
      ...participant,
      rank: index + 1,
    }));

  const participant = participants.get(participantId);
  const isParticipantCompleted = Boolean(participant && participant.completedAt !== null);
  const showReviewDetails = isAdmin || phase === "ended" || isParticipantCompleted;

  const state = {
    phase,
    startedAt,
    roundId,
    joinUrl: getJoinUrl(request),
    isAdmin,
    quizTitle: quizMeta.quizTitle,
    quizSubtitle: quizMeta.quizSubtitle,
    timeMinutes: quizMeta.timeMinutes,
    questions: questions.map((q) => ({
      id: q.id,
      scenarioId: q.scenarioId,
      section: q.section,
      scenarioTitle: q.scenarioTitle,
      scenarioText: q.scenarioText,
      scenarioSource: q.scenarioSource,
      type: q.type,
      typeLabel: q.typeLabel,
      prompt: q.prompt,
      options: q.options,
      ...(showReviewDetails ? { correct: q.correct, explanation: q.explanation, slides: q.slides } : {}),
    })),
    participantCount: participants.size,
    submittedAnswers: [...participants.values()].reduce(
      (total, p) =>
        total + p.answers.filter((answer) => answer !== null).length,
      0,
    ),
    completedCount: leaderboard.length,
    leaderboard,
  };
  if (participant) {
    state.participant = {
      answers: participant.answers,
      completed: participant.completedAt !== null,
      score: getScore(participant),
      correctOptionIndexes:
        participant.completedAt !== null || phase === "ended"
          ? questions.map(({ correct }) => correct)
          : null,
    };
  }
  return state;
}

function getAdminToken(request) {
  const authorization = request.headers.authorization || "";
  const match = authorization.match(/^Bearer (.+)$/);
  return match ? match[1] : "";
}

function isAdminRequest(request) {
  return adminSessions.has(getAdminToken(request));
}

function getJoinUrl(request) {
  if (configuredJoinUrl) return configuredJoinUrl;
  const forwardedProto = request.headers["x-forwarded-proto"]
    ?.split(",")[0]
    .trim()
    .toLowerCase();
  const protocol =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : request.socket.encrypted
        ? "https"
        : "http";
  const host = request.headers.host;
  if (!host) {
    throw new Error("Cannot determine the public join URL: the request has no Host header.");
  }
  let origin;
  try {
    origin = new URL(`${protocol}://${host}`);
  } catch {
    throw new Error("Cannot determine the public join URL: the request Host header is invalid.");
  }
  return normalizeJoinUrl(`${origin.origin}/?join=1`);
}

function normalizeJoinUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Enter a valid full join URL.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Enter a valid full join URL, including http:// or https://.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Join URL must use http:// or https:// and cannot include credentials.");
  }
  parsed.searchParams.set("join", "1");
  parsed.hash = "";
  return parsed.toString();
}

async function saveLocalConfig(joinUrl, questionList) {
  if (redis || process.env.VERCEL) return;
  const temporaryFile = `${CONFIG_FILE}.tmp`;
  let baseConfig = {};
  try {
    baseConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  const config = {
    ...baseConfig,
    ...(joinUrl ? { joinUrl } : {}),
    questions: questionList,
  };
  try {
    await fs.promises.writeFile(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "w",
    });
    await fs.promises.rename(temporaryFile, CONFIG_FILE);
  } catch (err) {
    console.warn("Could not save local config to disk:", err.message);
  }
}

async function saveJoinUrl(value) {
  const normalized = normalizeJoinUrl(value);
  await saveLocalConfig(normalized, questions);
  configuredJoinUrl = normalized;
}

async function updateQuestions(body) {
  if (phase !== "lobby") {
    return { status: 409, error: "Questions can only be changed while the quiz is in the lobby." };
  }

  let nextQuestions;
  if (body.action === "add") {
    if (questions.length >= MAX_QUESTIONS) {
      return { status: 400, error: `A quiz can contain at most ${MAX_QUESTIONS} questions.` };
    }
    try {
      nextQuestions = normalizeQuestions([...questions, body.question]);
    } catch (error) {
      return { status: 400, error: error.message };
    }
  } else if (body.action === "edit" || body.action === "delete") {
    if (!Number.isInteger(body.index) || body.index < 0 || body.index >= questions.length) {
      return { status: 400, error: "Choose a valid question to update." };
    }
    const updatedQuestions = [...questions];
    if (body.action === "edit") updatedQuestions[body.index] = body.question;
    else updatedQuestions.splice(body.index, 1);
    try {
      nextQuestions = normalizeQuestions(updatedQuestions);
    } catch (error) {
      return { status: 400, error: error.message };
    }
  } else {
    return { status: 400, error: "Choose add, edit, or delete for a question." };
  }

  await saveLocalConfig(configuredJoinUrl, nextQuestions);
  questions = nextQuestions;
  participants.forEach((participant) => {
    participant.answers = Array(questions.length).fill(null);
    participant.completedAt = null;
  });
  roundId += 1;
  return null;
}

function passwordsMatch(candidate) {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(ADMIN_PASSWORD);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function handleApiRequest(request, response, url) {
  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
    if (!passwordsMatch(body.password)) {
      return json(response, 401, { error: "Incorrect admin passcode." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.add(token);
    return json(response, 200, { token });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    adminSessions.delete(getAdminToken(request));
    return json(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    return json(
      response,
      200,
      getState(
        url.searchParams.get("participantId"),
        isAdminRequest(request),
        request,
      ),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/results.csv") {
    if (!isAdminRequest(request)) {
      return json(response, 401, { error: "Admin passcode required." });
    }
    if (phase !== "ended") {
      return json(response, 409, { error: "Wrap the quiz before downloading results." });
    }

    const rankedIds = getState(undefined, true, request).leaderboard.map(({ id }) => id);
    const rankedParticipants = rankedIds.map((id) => participants.get(id));
    const unrankedParticipants = [...participants.values()]
      .filter((participant) => participant.completedAt === null)
      .sort(
        (a, b) =>
          getScore(b) - getScore(a) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    const orderedParticipants = [
      ...rankedParticipants,
      ...unrankedParticipants,
    ];
    const headers = [
      "Rank",
      "Name",
      "Status",
      ...questions.map(
        (question, index) =>
          `Q${index + 1} [${question.section === "direct" ? "Direct" : `Scenario ${question.scenarioId}`} · ${question.typeLabel || question.type}]: ${question.prompt}`,
      ),
      "Score",
      "Total time",
    ];
    const rows = orderedParticipants.map((participant, index) => {
      const completed = participant.completedAt !== null;
      const answers = participant.answers.map((answer, questionIndex) => {
        if (answer === null) return "Not answered";
        const answerText = questions[questionIndex].options[answer];
        return `${answerText} (${answer === questions[questionIndex].correct ? "Correct" : "Incorrect"})`;
      });
      return [
        completed ? index + 1 : "",
        participant.name,
        completed ? "Completed" : "Not completed",
        ...answers,
        getScore(participant),
        completed ? formatDuration(participant.completedAt - startedAt) : "Not completed",
      ];
    });
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    response.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="quiz-scoresheet.csv"',
      "Cache-Control": "no-store",
    });
    response.end(`\uFEFF${csv}`);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/qr") {
    try {
      const svg = await QRCode.toString(getJoinUrl(request), {
        type: "svg",
        width: 280,
        margin: 1,
        color: { dark: "#101523", light: "#ffffff" },
      });
      response.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(svg);
    } catch (error) {
      console.error("Could not generate the join QR code:", error);
      json(response, 500, { error: "Could not generate the join QR code." });
    }
    return;
  }

  if (request.method !== "POST") {
    return json(response, 405, { error: "Method not allowed." });
  }

  if (
    ["/api/start", "/api/end", "/api/reset", "/api/admin/join-url", "/api/admin/questions"].includes(url.pathname) &&
    !isAdminRequest(request)
  ) {
    return json(response, 401, { error: "Admin passcode required." });
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return json(response, 400, { error: error.message });
  }

  if (url.pathname === "/api/admin/questions") {
    const error = await updateQuestions(body);
    if (error) return json(response, error.status, { error: error.error });
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/join") {
    if (phase === "ended") {
      return json(response, 409, { error: "This quiz has ended." });
    }
    const id = typeof body.id === "string" ? body.id.slice(0, 80) : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 24) : "";
    if (!id || !name) {
      return json(response, 400, { error: "Enter a name to join the quiz." });
    }
    if (!participants.has(id)) {
      participants.set(id, {
        id,
        name,
        answers: Array(questions.length).fill(null),
        completedAt: null,
      });
    } else {
      participants.get(id).name = name;
    }
    return json(response, 200, {
      participantId: id,
      state: getState(id, isAdminRequest(request), request),
    });
  }

  if (url.pathname === "/api/start") {
    if (phase !== "lobby") {
      return json(response, 409, { error: "The quiz has already started." });
    }
    phase = "live";
    startedAt = Date.now();
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/end") {
    if (phase !== "live") {
      return json(response, 409, { error: "There is no live quiz to end." });
    }
    phase = "ended";
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/reset") {
    participants.clear();
    phase = "lobby";
    startedAt = null;
    roundId += 1;
    questions = normalizeQuestions(defaultQuestions);
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/admin/join-url") {
    try {
      await saveJoinUrl(body.joinUrl);
    } catch (error) {
      if (error.message.startsWith("Enter a valid") || error.message.startsWith("Join URL")) {
        return json(response, 400, { error: error.message });
      }
      throw error;
    }
    return json(response, 200, getState(undefined, true, request));
  }

  if (url.pathname === "/api/answer") {
    const participant = participants.get(body.id);
    if (!participant) {
      return json(response, 404, { error: "Join the quiz before submitting an answer." });
    }
    if (phase !== "live") {
      return json(response, 409, { error: "The quiz is not accepting answers right now." });
    }
    const { questionIndex, optionIndex } = body;
    if (
      !Number.isInteger(questionIndex) ||
      questionIndex < 0 ||
      questionIndex >= questions.length ||
      !Number.isInteger(optionIndex) ||
      optionIndex < 0 ||
      optionIndex >= questions[questionIndex].options.length
    ) {
      return json(response, 400, { error: "Choose a valid answer." });
    }
    participant.answers[questionIndex] = optionIndex;
    if (participant.answers.every((answer) => answer !== null)) {
      participant.completedAt = participant.completedAt || Date.now();
    }
    return json(response, 200, {
      score: getScore(participant),
      correctAnswers: participant.answers.map((answer, index) =>
        answer === null ? null : answer === questions[index].correct,
      ),
      state: getState(body.id, isAdminRequest(request), request),
    });
  }

  return json(response, 404, { error: "Not found." });
}

async function handleApi(request, response, url) {
  if (!redis) return handleApiRequest(request, response, url);

  let releaseLocalQueue;
  const previousLocalRequest = sharedRequestQueue;
  sharedRequestQueue = new Promise((resolve) => {
    releaseLocalQueue = resolve;
  });
  await previousLocalRequest;

  const mutatingRequest = request.method === "POST";
  let lockToken;
  try {
    if (mutatingRequest) lockToken = await acquireStateLock();
    await loadSharedState();
    let responseStatus = 200;
    let responseHeaders;
    let responseBody;
    let responseEnded = false;
    const bufferedResponse = mutatingRequest
      ? new Proxy(response, {
          get(target, property) {
            if (property === "writeHead") {
              return (status, headers) => {
                responseStatus = status;
                responseHeaders = headers;
                return response;
              };
            }
            if (property === "end") {
              return (body) => {
                responseBody = body;
                responseEnded = true;
                return response;
              };
            }
            return Reflect.get(target, property, target);
          },
        })
      : response;
    await handleApiRequest(request, bufferedResponse, url);
    if (mutatingRequest) await saveSharedState();
    if (lockToken) {
      await releaseStateLock(lockToken);
      lockToken = null;
    }
    if (responseEnded) {
      response.writeHead(responseStatus, responseHeaders);
      response.end(responseBody);
    }
  } finally {
    if (lockToken) await releaseStateLock(lockToken);
    releaseLocalQueue();
  }
}

function serveFile(request, response, pathname) {
  let requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  if (requestedPath === "/admin" || requestedPath === "/admin/") {
    requestedPath = "/admin.html";
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Could not read file");
      return;
    }
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(contents);
  });
}

async function vercelHandler(request, response) {
  try {
    const protocol = request.headers["x-forwarded-proto"] || "https";
    const host = request.headers.host || process.env.VERCEL_URL || "localhost";
    const url = new URL(request.url || "/", `${protocol.split(",")[0]}://${host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("Method not allowed");
      return;
    }

    let requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    if (requestedPath === "/admin" || requestedPath === "/admin/") {
      requestedPath = "/admin.html";
    }
    const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
    if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    let contents;
    try {
      contents = await fs.promises.readFile(filePath);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Could not read file");
      return;
    }
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(contents);
  } catch (error) {
    console.error("Request failed:", error);
    if (!response.headersSent) {
      json(response, 500, { error: "An unexpected server error occurred." });
    }
  }
}

if (require.main === module) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      handleApi(request, response, url).catch((error) => {
        console.error("Request failed:", error);
        if (!response.headersSent) {
          json(response, 500, { error: "An unexpected server error occurred." });
        }
      });
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("Method not allowed");
      return;
    }
    serveFile(request, response, url.pathname);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Quiz dashboard: http://localhost:${PORT}`);
    console.log(
      configuredJoinUrl
        ? `Configured audience URL: ${configuredJoinUrl}`
        : "Audience QR uses the host/domain used to open the dashboard.",
    );
    if (!process.env.QUIZ_ADMIN_PASSWORD) {
      console.log(`Generated admin passcode (visible only in this server console): ${ADMIN_PASSWORD}`);
    }
  });
}

module.exports = vercelHandler;
module.exports.handleApi = handleApi;
