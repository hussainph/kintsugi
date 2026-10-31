'use client';

import { useState, type ComponentProps } from 'react';
import { Input } from '@base-ui/react/input';
import { componentCssStyle, type ComponentStyle } from "../../lib/theme-model";
import { inputAppearanceState } from "../../lib/component-appearances";

export function ThemedInput({
  appearances,
  className,
  style,
  onFocus,
  onBlur,
  onPointerEnter,
  onPointerLeave,
  ...props
}: ComponentProps<typeof Input> & {
  appearances: Record<'rest' | 'hover' | 'focus' | 'disabled', ComponentStyle>
    & Partial<Record<'invalid' | 'valid' | 'readonly', ComponentStyle>>;
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Input
      {...props}
      className={(state) =>
        [
          'themed-input',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...componentCssStyle(
          appearances[inputAppearanceState({
            disabled: state.disabled,
            valid: state.valid,
            focused: focused || state.focused,
            hovered,
            readOnly: props.readOnly,
            invalid: props['aria-invalid'] === true || props['aria-invalid'] === 'true',
          })] ?? appearances.rest,
        ),
        ...(typeof style === 'function' ? style(state) : style),
      })}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      onPointerEnter={(event) => {
        setHovered(true);
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        setHovered(false);
        onPointerLeave?.(event);
      }}
    />
  );
}
