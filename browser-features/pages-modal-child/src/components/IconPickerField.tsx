/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentType, SVGProps } from "react";

type LucideIconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

interface BuiltinOption {
  label: string;
  value: string;
  icon?: string;
}

interface IconPickerFieldProps {
  options: BuiltinOption[];
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

const MAX_LIBRARY_RESULTS = 120;

const pascalToWords = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/**
 * Render a Lucide icon to a standalone SVG data URI so the stored workspace
 * icon never needs the icon library at display time. currentColor is swapped
 * for context-stroke/fill, which Firefox chrome CSS can tint via
 * -moz-context-properties.
 */
const lucideToDataUri = (Icon: LucideIconComponent): string => {
  const svg = renderToStaticMarkup(
    <Icon xmlns="http://www.w3.org/2000/svg" size={16} strokeWidth={2} />,
  );
  const themed = svg
    .replaceAll('stroke="currentColor"', 'stroke="context-stroke"')
    .replaceAll('fill="currentColor"', 'fill="context-fill"');
  try {
    return `data:image/svg+xml;base64,${btoa(themed)}`;
  } catch {
    return `data:image/svg+xml;utf8,${encodeURIComponent(themed)}`;
  }
};

export function IconPickerField(
  { options, value, placeholder, onChange }: IconPickerFieldProps,
) {
  const [query, setQuery] = useState("");
  const [lucideIcons, setLucideIcons] = useState<
    Record<string, LucideIconComponent> | null
  >(null);
  const [pickedLibraryName, setPickedLibraryName] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let mounted = true;
    // Lazy: the full icon set only loads when the picker is on screen.
    import("lucide-react").then((mod) => {
      if (mounted) {
        setLucideIcons(mod.icons as Record<string, LucideIconComponent>);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredBuiltins = useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(normalizedQuery) ||
        opt.value.toLowerCase().includes(normalizedQuery),
    );
  }, [options, normalizedQuery]);

  const filteredLucide = useMemo(() => {
    if (!lucideIcons) return [];
    const names = Object.keys(lucideIcons);
    const matches = normalizedQuery
      ? names.filter((name) => pascalToWords(name).includes(normalizedQuery))
      : names;
    return matches.slice(0, MAX_LIBRARY_RESULTS);
  }, [lucideIcons, normalizedQuery]);

  const isCustomValue = value.startsWith("data:image/");

  const cellClass = (selected: boolean) =>
    `flex items-center justify-center h-8 w-8 rounded-md cursor-pointer border transition duration-100 ${
      selected
        ? "border-[#0061E0] ring-2 ring-[#0061E0] bg-blue-50 dark:bg-[#003b8e]"
        : "border-transparent hover:bg-gray-100 dark:hover:bg-gray-600"
    }`;

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder || "Search icons…"}
        className="w-full px-4 py-2 mb-2 text-gray-900 dark:text-white bg-white dark:bg-[#42414D] border border-gray-300 dark:border-[#42414D] rounded-md focus:outline-none focus:ring-2 focus:ring-[#0061E0] transition duration-150 ease-in-out"
      />
      <div className="grid grid-cols-10 gap-1 max-h-52 overflow-y-auto scrollbar-thin p-1 border border-gray-300 dark:border-[#42414D] rounded-md">
        {filteredBuiltins.map((opt) => (
          <button
            key={opt.value}
            type="button"
            title={opt.label}
            className={cellClass(!isCustomValue && value === opt.value)}
            onClick={() => {
              setPickedLibraryName(null);
              onChange(opt.value);
            }}
          >
            {opt.icon ? <img src={opt.icon} className="w-4 h-4" alt="" /> : (
              <span className="text-xs">{opt.label.slice(0, 2)}</span>
            )}
          </button>
        ))}
        {filteredLucide.map((name) => {
          const Icon = lucideIcons?.[name];
          if (!Icon) return null;
          return (
            <button
              key={`lucide-${name}`}
              type="button"
              title={pascalToWords(name)}
              className={cellClass(
                isCustomValue && pickedLibraryName === name,
              )}
              onClick={() => {
                setPickedLibraryName(name);
                onChange(lucideToDataUri(Icon));
              }}
            >
              <Icon size={16} className="text-gray-900 dark:text-white" />
            </button>
          );
        })}
      </div>
      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {!lucideIcons
          ? "Loading icon library…"
          : isCustomValue && !pickedLibraryName
          ? (
            <span className="inline-flex items-center gap-1">
              Current custom icon:
              <img src={value} className="w-4 h-4 inline" alt="" />
            </span>
          )
          : filteredLucide.length === MAX_LIBRARY_RESULTS
          ? "Showing first matches — type to refine"
          : `${filteredBuiltins.length + filteredLucide.length} icons`}
      </div>
    </div>
  );
}
