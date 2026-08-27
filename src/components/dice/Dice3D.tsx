import React, { useState, useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';

interface Dice3DProps {
  dice: [number, number];
  isRolling?: boolean;
  onRollClick?: () => void;
  canRoll?: boolean;
  hasCharityBonus?: boolean;
}

export const Dice3D: React.FC<Dice3DProps> = ({ 
  dice, 
  isRolling = false, 
  onRollClick, 
  canRoll = false,
  hasCharityBonus = false
}) => {
  const [animating, setAnimating] = useState(false);
  const [displayValues, setDisplayValues] = useState<[number, number]>(dice);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isRolling) {
      setAnimating(true);

      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);

      intervalRef.current = setInterval(() => {
        setDisplayValues([
          Math.floor(Math.random() * 6) + 1,
          Math.floor(Math.random() * 6) + 1
        ]);
      }, 50);

      timerRef.current = setTimeout(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setDisplayValues(dice);
        setAnimating(false);
      }, 420);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
      setDisplayValues(dice);
      setAnimating(false);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isRolling, dice[0], dice[1]]);

  const renderDiceFace = (value: number) => {
    switch (value) {
      case 1:
        return (
          <div className="dice-grid">
            <div className="dice-cell-2-2 dice-dot-red" />
          </div>
        );
      case 2:
        return (
          <div className="dice-grid">
            <div className="dice-cell-1-3 dice-dot-black" />
            <div className="dice-cell-3-1 dice-dot-black" />
          </div>
        );
      case 3:
        return (
          <div className="dice-grid">
            <div className="dice-cell-1-3 dice-dot-black" />
            <div className="dice-cell-2-2 dice-dot-black" />
            <div className="dice-cell-3-1 dice-dot-black" />
          </div>
        );
      case 4:
        return (
          <div className="dice-grid">
            <div className="dice-cell-1-1 dice-dot-black" />
            <div className="dice-cell-1-3 dice-dot-black" />
            <div className="dice-cell-3-1 dice-dot-black" />
            <div className="dice-cell-3-3 dice-dot-black" />
          </div>
        );
      case 5:
        return (
          <div className="dice-grid">
            <div className="dice-cell-1-1 dice-dot-black" />
            <div className="dice-cell-1-3 dice-dot-black" />
            <div className="dice-cell-2-2 dice-dot-red-small" />
            <div className="dice-cell-3-1 dice-dot-black" />
            <div className="dice-cell-3-3 dice-dot-black" />
          </div>
        );
      case 6:
        return (
          <div className="dice-grid">
            <div className="dice-cell-1-1 dice-dot-black" />
            <div className="dice-cell-2-1 dice-dot-black" />
            <div className="dice-cell-3-1 dice-dot-black" />
            <div className="dice-cell-1-3 dice-dot-black" />
            <div className="dice-cell-2-3 dice-dot-black" />
            <div className="dice-cell-3-3 dice-dot-black" />
          </div>
        );
      default:
        return (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xl font-black text-slate-900">{value}</span>
          </div>
        );
    }
  };

  const val1 = displayValues[0] || 1;
  const val2 = displayValues[1] || 1;

  return (
    <div className="flex flex-col items-center justify-center my-1 select-none">
      <div
        onClick={canRoll && !animating && !isRolling ? onRollClick : undefined}
        className={`flex items-center gap-2.5 p-2 rounded-2xl transition-all ${
          canRoll && !animating && !isRolling
            ? 'cursor-pointer hover:bg-slate-900/90 active:scale-95 ring-2 ring-amber-400/80 shadow-xl shadow-amber-500/25 bg-[#0f172a] animate-pulse-glow'
            : 'bg-[#0b1222]/80 border border-slate-800'
        }`}
        title={canRoll && !animating && !isRolling ? 'انقر هنا لرمي النرد!' : undefined}
      >
        <div 
          className={`dice-cube-large ${canRoll && !animating && !isRolling ? 'dice-clickable' : ''} ${
            animating ? 'dice-rolling-1' : ''
          }`}
        >
          {renderDiceFace(val1)}
        </div>

        {true && (
          <div 
            className={`dice-cube-large ${canRoll && !animating && !isRolling ? 'dice-clickable' : ''} ${
              animating ? 'dice-rolling-2' : ''
            }`}
          >
            {renderDiceFace(val2)}
          </div>
        )}
      </div>
    </div>
  );
};
