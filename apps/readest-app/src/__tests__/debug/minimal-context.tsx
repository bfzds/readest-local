/**
 * [DEBUG-mock1] Throwaway minimal .tsx context module. Delete after diagnosis.
 */
import { createContext, useContext } from 'react';

interface MinimalContextType {
  marker: string;
}

const MinimalContext = createContext<MinimalContextType | undefined>(undefined);

export const useMinimal = (): MinimalContextType => {
  const context = useContext(MinimalContext);
  if (!context) throw new Error('useMinimal must be used within MinimalProvider');
  return context;
};
