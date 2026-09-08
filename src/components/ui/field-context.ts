import { createContext, useContext } from 'react';

export const FieldContext = createContext<{ id: string; label: string; descriptionId?: string | undefined; invalid: boolean } | null>(null);
export const useField = () => useContext(FieldContext);
