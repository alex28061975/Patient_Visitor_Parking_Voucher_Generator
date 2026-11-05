import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Search, ChevronDown } from 'lucide-react';
import { ParsedVoucherData } from '../utils/csvParser';
import { cleanVoucherCodeValue } from '../utils/voucherValidation';

interface VoucherCodePickerProps {
  codes: ParsedVoucherData[];
  onSelect: (code: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const VoucherCodePicker: React.FC<VoucherCodePickerProps> = ({
  codes,
  onSelect,
  disabled = false,
  placeholder = "Choose Code"
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredCodes = useMemo(() => {
    if (!query.trim()) return codes;
    const q = query.toLowerCase();
    return codes.filter(v => {
      const c = cleanVoucherCodeValue(v.code).toLowerCase();
      return c.includes(q);
    });
  }, [codes, query]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setIsOpen(true);
      return;
    }
    if (!isOpen) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev < filteredCodes.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredCodes.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCodes[selectedIndex]) {
        const c = cleanVoucherCodeValue(filteredCodes[selectedIndex].code).toUpperCase();
        onSelect(c);
        setIsOpen(false);
        setQuery('');
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-block w-[220px]">
      <div
        className={`flex items-center w-full bg-[#020B19] border rounded-lg px-2.5 h-8 transition shadow-sm ${
          disabled
            ? 'opacity-60 cursor-not-allowed border-slate-800'
            : 'border-slate-700 focus-without:border-emerald-500 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20 cursor-text'
        }`}
      >
        <Search className="w-3.5 h-3.5 text-slate-400 shrink-0 mr-1.5" />
        <input
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-controls="voucher-listbox"
          aria-autocomplete="list"
          disabled={disabled}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
            setSelectedIndex(0);
          }}
          onFocus={() => {
            if (!disabled) {
              setIsOpen(true);
              setSelectedIndex(0);
            }
          }}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent text-xs font-mono font-bold text-white placeholder-slate-400 focus:outline-none"
        />
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0 ml-1" />
      </div>

      {isOpen && !disabled && (
        <ul
          id="voucher-listbox"
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-[210px] overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg shadow-xl py-1 text-white font-mono text-xs"
        >
          {filteredCodes.length === 0 ? (
            <li className="px-3 py-2 text-slate-400 text-center text-xs font-sans">No match</li>
          ) : (
            filteredCodes.map((v, index) => {
              const c = cleanVoucherCodeValue(v.code).toUpperCase();
              const isSelected = index === selectedIndex;
              return (
                <li
                  key={`picker_${c}_${index}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => {
                    onSelect(c);
                    setIsOpen(false);
                    setQuery('');
                  }}
                  className={`px-3 py-1.5 cursor-pointer flex items-center justify-between transition ${
                    isSelected ? 'bg-emerald-600/30 text-emerald-300 font-bold' : 'hover:bg-slate-800 text-slate-200'
                  }`}
                >
                  <span>{c}</span>
                  {v.hospital && <span className="text-[10px] text-slate-400 font-sans">{v.hospital}</span>}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
};
