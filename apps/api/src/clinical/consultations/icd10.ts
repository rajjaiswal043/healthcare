/**
 * A working subset of ICD-10, for diagnosis autocomplete.
 *
 * WHY THIS IS IN CODE and not a table: ICD-10 is a published standard, identical
 * for every tenant. A table would invite editing it, and a clinic that renames
 * J06.9 has broken every report and every record it will ever exchange over
 * ABDM. The tenant-editable thing is the FORMULARY, which genuinely differs by
 * clinic; the code set is not.
 *
 * This is roughly the top of an Indian general-OPD day, not the full
 * classification — that runs to about seventy thousand codes and shipping it
 * would make the search useless as well as large. A doctor who needs something
 * absent types free text, which the model supports precisely so that a missing
 * code never blocks a consultation.
 *
 * Codes are ICD-10 (WHO). Descriptions are shortened to what a doctor would
 * recognise on a dropdown rather than the formal rubric.
 */

export interface DiagnosisCode {
  code: string;
  display: string;
  /** Extra words that should match the search but do not belong in the label. */
  synonyms?: string;
}

export const ICD10_CODES: DiagnosisCode[] = [
  // --- respiratory ---------------------------------------------------------
  { code: 'J00', display: 'Acute nasopharyngitis (common cold)', synonyms: 'cold coryza' },
  { code: 'J01.9', display: 'Acute sinusitis', synonyms: 'sinus' },
  { code: 'J02.9', display: 'Acute pharyngitis', synonyms: 'sore throat' },
  { code: 'J03.9', display: 'Acute tonsillitis', synonyms: 'tonsils' },
  { code: 'J04.0', display: 'Acute laryngitis', synonyms: 'hoarse voice' },
  { code: 'J06.9', display: 'Upper respiratory tract infection', synonyms: 'URTI URI' },
  { code: 'J18.9', display: 'Pneumonia, organism unspecified', synonyms: 'chest infection' },
  { code: 'J20.9', display: 'Acute bronchitis', synonyms: 'chest cough' },
  { code: 'J30.4', display: 'Allergic rhinitis', synonyms: 'hay fever sneezing' },
  { code: 'J40', display: 'Bronchitis, not specified as acute or chronic' },
  { code: 'J44.9', display: 'Chronic obstructive pulmonary disease', synonyms: 'COPD' },
  { code: 'J45.9', display: 'Asthma', synonyms: 'wheeze wheezing' },
  { code: 'R05', display: 'Cough' },
  { code: 'R06.0', display: 'Dyspnoea', synonyms: 'breathlessness short of breath' },

  // --- infectious ----------------------------------------------------------
  {
    code: 'A09',
    display: 'Gastroenteritis and colitis, infectious',
    synonyms: 'loose motions diarrhoea',
  },
  { code: 'A01.0', display: 'Typhoid fever', synonyms: 'enteric' },
  { code: 'A90', display: 'Dengue fever' },
  { code: 'B54', display: 'Malaria, unspecified' },
  { code: 'B34.9', display: 'Viral infection, unspecified', synonyms: 'viral fever' },
  { code: 'A15.9', display: 'Respiratory tuberculosis', synonyms: 'TB koch' },
  { code: 'B01.9', display: 'Chickenpox', synonyms: 'varicella' },
  { code: 'B02.9', display: 'Herpes zoster', synonyms: 'shingles' },
  { code: 'B35.9', display: 'Dermatophytosis', synonyms: 'ringworm fungal tinea' },
  { code: 'B37.9', display: 'Candidiasis', synonyms: 'thrush fungal' },
  { code: 'U07.1', display: 'COVID-19, virus identified' },

  // --- gastrointestinal ----------------------------------------------------
  {
    code: 'K21.9',
    display: 'Gastro-oesophageal reflux disease',
    synonyms: 'GERD acidity heartburn',
  },
  { code: 'K29.7', display: 'Gastritis, unspecified', synonyms: 'acidity' },
  { code: 'K30', display: 'Functional dyspepsia', synonyms: 'indigestion' },
  { code: 'K59.0', display: 'Constipation' },
  { code: 'K58.9', display: 'Irritable bowel syndrome', synonyms: 'IBS' },
  { code: 'K64.9', display: 'Haemorrhoids', synonyms: 'piles' },
  { code: 'K76.0', display: 'Fatty liver', synonyms: 'hepatic steatosis NAFLD' },
  { code: 'R10.4', display: 'Abdominal pain, unspecified', synonyms: 'stomach pain' },
  { code: 'R11', display: 'Nausea and vomiting' },

  // --- cardiometabolic -----------------------------------------------------
  { code: 'E11.9', display: 'Type 2 diabetes mellitus', synonyms: 'diabetes sugar T2DM' },
  { code: 'E10.9', display: 'Type 1 diabetes mellitus' },
  { code: 'E66.9', display: 'Obesity' },
  { code: 'E78.5', display: 'Hyperlipidaemia', synonyms: 'cholesterol lipids' },
  { code: 'E03.9', display: 'Hypothyroidism', synonyms: 'thyroid' },
  { code: 'E05.9', display: 'Hyperthyroidism', synonyms: 'thyroid' },
  { code: 'I10', display: 'Essential hypertension', synonyms: 'high BP blood pressure' },
  { code: 'I20.9', display: 'Angina pectoris', synonyms: 'chest pain cardiac' },
  { code: 'I25.9', display: 'Chronic ischaemic heart disease', synonyms: 'IHD CAD' },
  { code: 'I48.9', display: 'Atrial fibrillation', synonyms: 'AF' },
  { code: 'D50.9', display: 'Iron deficiency anaemia', synonyms: 'anemia low haemoglobin' },

  // --- musculoskeletal -----------------------------------------------------
  { code: 'M54.5', display: 'Low back pain', synonyms: 'lumbago backache' },
  { code: 'M54.2', display: 'Cervicalgia', synonyms: 'neck pain' },
  { code: 'M25.5', display: 'Joint pain', synonyms: 'arthralgia' },
  { code: 'M17.9', display: 'Osteoarthritis of knee', synonyms: 'knee OA' },
  { code: 'M06.9', display: 'Rheumatoid arthritis' },
  { code: 'M79.1', display: 'Myalgia', synonyms: 'body ache muscle pain' },
  { code: 'M10.9', display: 'Gout', synonyms: 'uric acid' },
  { code: 'S93.4', display: 'Sprain of ankle' },

  // --- neurological and mental health --------------------------------------
  { code: 'G43.9', display: 'Migraine' },
  { code: 'G44.2', display: 'Tension-type headache' },
  { code: 'R51', display: 'Headache' },
  { code: 'R42', display: 'Dizziness and giddiness', synonyms: 'vertigo' },
  { code: 'G47.0', display: 'Insomnia', synonyms: 'sleeplessness' },
  { code: 'F41.9', display: 'Anxiety disorder', synonyms: 'anxiety' },
  { code: 'F32.9', display: 'Depressive episode', synonyms: 'depression' },
  { code: 'F41.2', display: 'Mixed anxiety and depressive disorder' },

  // --- skin ----------------------------------------------------------------
  { code: 'L20.9', display: 'Atopic dermatitis', synonyms: 'eczema' },
  { code: 'L23.9', display: 'Allergic contact dermatitis', synonyms: 'rash allergy' },
  { code: 'L30.9', display: 'Dermatitis, unspecified', synonyms: 'rash' },
  { code: 'L50.9', display: 'Urticaria', synonyms: 'hives allergy' },
  { code: 'L70.0', display: 'Acne vulgaris', synonyms: 'pimples' },
  { code: 'L03.9', display: 'Cellulitis', synonyms: 'skin infection' },

  // --- eye, ear, dental ----------------------------------------------------
  { code: 'H10.9', display: 'Conjunctivitis', synonyms: 'red eye' },
  { code: 'H60.9', display: 'Otitis externa', synonyms: 'ear infection' },
  { code: 'H66.9', display: 'Otitis media', synonyms: 'ear infection middle' },
  { code: 'H61.2', display: 'Impacted cerumen', synonyms: 'ear wax' },
  { code: 'K02.9', display: 'Dental caries', synonyms: 'tooth decay' },

  // --- genitourinary and obstetric -----------------------------------------
  { code: 'N39.0', display: 'Urinary tract infection', synonyms: 'UTI burning urination' },
  { code: 'N20.0', display: 'Calculus of kidney', synonyms: 'kidney stone renal' },
  { code: 'N91.2', display: 'Amenorrhoea, unspecified', synonyms: 'missed periods' },
  { code: 'N94.6', display: 'Dysmenorrhoea', synonyms: 'period pain' },
  { code: 'Z34.9', display: 'Supervision of normal pregnancy', synonyms: 'antenatal ANC' },
  { code: 'N18.9', display: 'Chronic kidney disease', synonyms: 'CKD renal failure' },

  // --- general and administrative ------------------------------------------
  { code: 'R50.9', display: 'Fever, unspecified' },
  { code: 'R53.83', display: 'Fatigue', synonyms: 'tiredness weakness' },
  { code: 'R63.0', display: 'Anorexia', synonyms: 'loss of appetite' },
  { code: 'T78.4', display: 'Allergy, unspecified' },
  {
    code: 'Z00.0',
    display: 'General medical examination',
    synonyms: 'routine check health checkup',
  },
  { code: 'Z23', display: 'Immunisation', synonyms: 'vaccination vaccine' },
  { code: 'Z76.0', display: 'Repeat prescription', synonyms: 'refill follow up' },
];

/**
 * Search by code or words, ranked so the obvious answer is first.
 *
 * A doctor types three or four letters and expects the thing they meant at the
 * top. Substring-anywhere matching alone puts "Supervision of normal pregnancy"
 * above "Fever" for the query "ver", which is why prefix matches outrank
 * contained ones and synonym hits rank below both.
 */
export function searchDiagnosisCodes(query: string, limit = 20): DiagnosisCode[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return ICD10_CODES.slice(0, limit);

  const scored: Array<{ item: DiagnosisCode; score: number }> = [];

  for (const item of ICD10_CODES) {
    const code = item.code.toLowerCase();
    const display = item.display.toLowerCase();
    const synonyms = item.synonyms?.toLowerCase() ?? '';

    let score = -1;

    if (code === q) score = 0;
    else if (code.startsWith(q)) score = 1;
    else if (display.startsWith(q)) score = 2;
    // A word within the description, e.g. "throat" matching "Acute pharyngitis
    // (sore throat)" — worth more than an arbitrary substring.
    else if (display.split(/[\s(),]+/).some((w) => w.startsWith(q))) score = 3;
    else if (synonyms.split(/\s+/).some((w) => w.startsWith(q))) score = 4;
    else if (display.includes(q)) score = 5;
    else if (synonyms.includes(q)) score = 6;

    if (score >= 0) scored.push({ item, score });
  }

  scored.sort((a, b) => a.score - b.score || a.item.code.localeCompare(b.item.code));
  return scored.slice(0, limit).map((s) => s.item);
}
