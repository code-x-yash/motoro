import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn';

const baseControl =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 ' +
  'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:bg-slate-50';

export function Label({ className, children, ...rest }: LabelHTMLAttributesProps) {
  return (
    <label className={cn('mb-1 block text-xs font-medium text-slate-600', className)} {...rest}>
      {children}
    </label>
  );
}

type LabelHTMLAttributesProps = {
  className?: string;
  children?: ReactNode;
  htmlFor?: string;
};

export function Field({
  label,
  error,
  hint,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  error?: string | null;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {label ? <Label htmlFor={htmlFor}>{label}</Label> : null}
      {children}
      {error ? <p className="mt-1 text-xs text-rose-600">{error}</p> : null}
      {!error && hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export function Input({ className, error, ...rest }: InputProps) {
  return <input className={cn(baseControl, error && 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/30', className)} {...rest} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export function Textarea({ className, error, ...rest }: TextareaProps) {
  return (
    <textarea
      className={cn(baseControl, 'min-h-[96px] resize-y', error && 'border-rose-400', className)}
      {...rest}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export function Select({ className, error, children, ...rest }: SelectProps) {
  return (
    <select className={cn(baseControl, 'appearance-none pr-8', error && 'border-rose-400', className)} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({
  className,
  label,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className={cn('inline-flex items-center gap-2 text-sm text-slate-700', className)}>
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        {...rest}
      />
      {label}
    </label>
  );
}
