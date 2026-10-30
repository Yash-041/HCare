/**
 * Hand-labeled notes for measuring extraction quality (field-level precision/recall/F1).
 * Mix of English, Hinglish and Devanagari speech transcripts plus OCR-style lab text,
 * including negations and distractors. Labels list only what is explicitly stated.
 */
export interface Sample {
  id: string;
  lang: "en" | "hinglish" | "hi" | "ocr";
  text: string;
  expect: {
    symptoms?: string[];
    vitals?: Record<string, number>;
    medications?: string[];
    allergies?: string[];
    diagnosis?: string[];
    labs?: string[];
  };
}

export const SAMPLES: Sample[] = [
  {
    id: "en-1",
    lang: "en",
    text: "32 year old woman with fever for 4 days and headache. No cough. BP 110/70, pulse 104, temperature 101.2 F. Started paracetamol 500 mg TDS. Allergic to sulfa drugs.",
    expect: {
      symptoms: ["fever", "headache"],
      vitals: { bp_systolic: 110, bp_diastolic: 70, pulse: 104, temperature_c: 38.4 },
      medications: ["Paracetamol"],
      allergies: ["Sulfa drugs"],
    },
  },
  {
    id: "en-2",
    lang: "en",
    text: "Child brought with loose motions since yesterday and vomiting twice. Weight 11 kg. Denies blood in stool. ORS and zinc 20 mg OD for 14 days advised. Diagnosis: acute gastroenteritis.",
    expect: {
      symptoms: ["diarrhoea", "vomiting"],
      vitals: { weight_kg: 11 },
      medications: ["ORS", "Zinc"],
      diagnosis: ["acute gastroenteritis"],
    },
  },
  {
    id: "en-3",
    lang: "en",
    text: "Known case of hypertension and diabetes. Complains of dizziness and weakness for 2 weeks. BP is 160 over 100. Random blood sugar 245. Continue amlodipine 5 mg once daily and metformin 500 mg twice a day.",
    expect: {
      symptoms: ["dizziness", "weakness"],
      vitals: { bp_systolic: 160, bp_diastolic: 100, blood_glucose_mg_dl: 245 },
      medications: ["Amlodipine", "Metformin"],
      diagnosis: ["hypertension", "diabetes"],
    },
  },
  {
    id: "en-4",
    lang: "en",
    text: "Breathlessness and cough for one week, no chest pain, no fever. SpO2 91% on room air, respiratory rate 28. Salbutamol inhaler given. No known drug allergies.",
    expect: {
      symptoms: ["breathlessness", "cough"],
      vitals: { spo2: 91, resp_rate: 28 },
      medications: ["Salbutamol"],
    },
  },
  {
    id: "hinglish-1",
    lang: "hinglish",
    text: "Mareez ko teen din se bukhar hai aur badan dard bhi hai. Khansi nahi hai. BP 120/80, pulse 92. Dolo 650 din mein do baar. Penicillin se allergy hai.",
    expect: {
      symptoms: ["fever", "body ache"],
      vitals: { bp_systolic: 120, bp_diastolic: 80, pulse: 92 },
      medications: ["Paracetamol"],
      allergies: ["Penicillin"],
    },
  },
  {
    id: "hinglish-2",
    lang: "hinglish",
    text: "Do hafte se pet dard aur ulti ho rahi hai, bhookh nahi lagti. Weight 48 kg. Pantoprazole 40 mg subah khali pet, ondansetron zarurat padne par.",
    expect: {
      symptoms: ["abdominal pain", "vomiting", "loss of appetite"],
      vitals: { weight_kg: 48 },
      medications: ["Pantoprazole", "Ondansetron"],
    },
  },
  {
    id: "hi-1",
    lang: "hi",
    text: "मरीज़ को ५ दिन से खाँसी और बुखार है। सांस फूलना नहीं है। बीपी १३०/८५, नब्ज ८८। धूल से एलर्जी है।",
    expect: {
      symptoms: ["cough", "fever"],
      vitals: { bp_systolic: 130, bp_diastolic: 85, pulse: 88 },
      allergies: ["Dust"],
    },
  },
  {
    id: "hi-2",
    lang: "hi",
    text: "गर्भवती महिला, कमजोरी और चक्कर की शिकायत। वजन ५२ किलो। आयरन की गोली रोज़ एक बार।",
    expect: {
      symptoms: ["weakness", "dizziness"],
      vitals: { weight_kg: 52 },
      medications: ["Iron + Folic acid"],
    },
  },
  {
    id: "ocr-1",
    lang: "ocr",
    text: "SUNRISE PATHOLOGY LAB\nPatient: R. Devi   Age/Sex: 45/F\nHaemoglobin (Hb) : 8.9 g/dL   (12.0-15.5)\nTotal Leucocyte Count 11200 /cumm\nPlatelet Count 1.6 lakh/cumm\nFasting Blood Sugar 132 mg/dL\nS. Creatinine 0.9 mg/dl",
    expect: {
      vitals: { blood_glucose_mg_dl: 132 },
      labs: ["Haemoglobin", "Total WBC count", "Platelets", "Serum creatinine"],
    },
  },
  {
    id: "ocr-2",
    lang: "ocr",
    text: "Rx\n1. Tab Azithromycin 500 mg OD x 3 days\n2. Tab Cetirizine 10 mg HS x 5 days\n3. Syp Ambroxol 5 ml TDS\nDx: Lower respiratory tract infection\nReview after 5 days",
    expect: {
      medications: ["Azithromycin", "Cetirizine"],
      diagnosis: ["lower respiratory tract infection"],
    },
  },
];
