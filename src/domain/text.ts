// Match PostgreSQL char_length, including characters outside the BMP such as emoji.
export const countCharacters = (value: string): number => Array.from(value).length;
