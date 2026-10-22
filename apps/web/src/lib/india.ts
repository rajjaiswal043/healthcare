/**
 * India's states and union territories, for the one field people get wrong.
 *
 * A LIST RATHER THAN A TEXT BOX, because a free-typed state becomes "UP",
 * "U.P.", "Uttar pradesh" and "Uttar Pradesh " within a week, and then no
 * report can group by it and no insurer form can be filled from it. The names
 * are the official spellings — what a government form expects, not what a
 * search engine accepts.
 *
 * Alphabetical, with the union territories after the states, which is how every
 * Indian form orders them and therefore where a receptionist's eye will look.
 */
export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  // Union territories.
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
] as const;

/**
 * What the state field starts on.
 *
 * MOST PATIENTS LIVE NEAR THE CLINIC, so a default that is right most of the
 * time saves the commonest registration a decision — and the field is a
 * dropdown, so correcting it is one tap rather than retyping.
 *
 * HARDCODED, AND THAT IS A KNOWN LIMIT. This is the second clinic's first bug:
 * the value it replaces was a hidden `state: 'Maharashtra'` on the registration
 * form, which silently stamped every patient in the country with Pune. The
 * honest fix for a multi-tenant product is to default from the clinic's own
 * `location.state`, which exists in the schema — but nothing in the app can
 * edit a location yet, so there is no way for a clinic to set it. Until that
 * screen exists, this constant is the pragmatic answer for a single-clinic
 * pilot in Uttar Pradesh.
 */
export const DEFAULT_STATE = 'Uttar Pradesh';
