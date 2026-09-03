declare module 'ink-password-input' {
  import { ComponentProps } from 'react';
  export const PasswordInput: React.ComponentType<{
    value: string;
    onChange: (value: string) => void;
    onSubmit: (value: string) => void;
    placeholder?: string;
    isDisabled?: boolean;
  }>;
}
