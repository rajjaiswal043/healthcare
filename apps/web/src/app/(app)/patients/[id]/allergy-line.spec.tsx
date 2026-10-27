/**
 * The allergy line, state by state.
 *
 * Four cases, and the one that matters most is the pair at the bottom: the same
 * patient with nothing recorded reads differently depending on whether anybody
 * is in a position to ask them. That was reported from the clinic on 27 Oct
 * 2026 — the instruction drew on every record, including patients who had not
 * been near the place for months.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AllergyLine } from './allergy-line';

function render(props: {
  allergies?: string | null;
  reviewedAt?: string | null;
  hasLiveVisit?: boolean;
}) {
  return renderToStaticMarkup(
    <AllergyLine
      allergies={props.allergies ?? null}
      reviewedAt={props.reviewedAt ?? null}
      hasLiveVisit={props.hasLiveVisit ?? false}
    />,
  );
}

describe('a recorded allergy', () => {
  it('is loud whether or not the patient is in', () => {
    for (const hasLiveVisit of [true, false]) {
      const html = render({ allergies: 'Penicillin', hasLiveVisit });
      expect(html).toContain('Penicillin');
      expect(html).toContain('coral');
    }
  });
});

describe('asked, and none known', () => {
  it('says so quietly, with the date it was asked', () => {
    const html = render({ reviewedAt: '2026-10-20T06:00:00.000Z', hasLiveVisit: true });
    expect(html).toContain('No known allergies');
    expect(html).not.toContain('Ask before prescribing');
    expect(html).not.toContain('amber');
  });
});

describe('nobody has asked', () => {
  it('asks, in amber, while the patient is in', () => {
    const html = render({ hasLiveVisit: true });
    expect(html).toContain('Allergies not recorded. Ask before prescribing.');
    expect(html).toContain('amber');
  });

  it('states the fact and asks nothing when the patient is not in', () => {
    const html = render({ hasLiveVisit: false });
    expect(html).toContain('Allergies not recorded');
    // The instruction is the part that was wrong, not the fact.
    expect(html).not.toContain('Ask before prescribing');
  });

  it('drops the panel when the patient is not in, and keeps it when they are', () => {
    // The panel is the shouting: a border and a fill. Without a visit the line
    // sits in the record's own voice instead.
    expect(render({ hasLiveVisit: false })).not.toContain('rounded-panel');
    expect(render({ hasLiveVisit: true })).toContain('rounded-panel');
  });
});

describe('no dash in any state', () => {
  it('is free of em dashes, which read as a double hyphen at this size', () => {
    const states = [
      render({ allergies: 'Penicillin', hasLiveVisit: true }),
      render({ reviewedAt: '2026-10-20T06:00:00.000Z' }),
      render({ hasLiveVisit: true }),
      render({ hasLiveVisit: false }),
    ];

    for (const html of states) expect(html).not.toContain('—');
  });
});
