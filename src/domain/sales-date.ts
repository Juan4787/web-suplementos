const calendar = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit'
});

/** Canonical business date, independent of device timezone and locale layout. */
export const salesDateAt = (instant: string | Date): string => {
  const parts = calendar.formatToParts(typeof instant === 'string' ? new Date(instant) : instant);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
};

/** A local calendar anchor for date-fns; the date itself comes from Buenos Aires. */
export const salesReferenceDate = (): Date => new Date(`${salesDateAt(new Date())}T12:00:00`);
