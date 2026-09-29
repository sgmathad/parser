import type { Validation } from '@/interface';

// Hook used for validation purposes. Returns a validation
// type.
export const useValidation = (): Validation => {
  // Email regex. Should start with a alpha-numeric value.
  // Name = Can have [., +, _] characters.
  // Domain = Can have alpha-numeric values.
  // TLD = [.com, .dev, .edu, .org, .net] allowed
  const emailRegex =
    /^[0-9a-zA-Z]+(\.?[0-9a-zA-Z+_])*@[0-9a-zA-Z]+\.(com|dev|edu|org|net)$/;

  // Password regex. Length should be in the range of [15, 30].
  // Password must contain atleast - one Uppercase, one LowerCase, one Number.
  const passwordRegex = /^((?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])).{15,30}$/;

  /**
   * Method to test whether email matches the email regex.
   * @param email Email to be validated
   * @returns boolean
   */
  const isEmailValid = (email: string): boolean => {
    return emailRegex.test(email);
  };

  /**
   * Method to check if the password is valid.
   * Matches password regex defined above.
   * @param password - A password string entered.
   * @returns boolean
   */
  const isPasswordValid = (password: string): boolean => {
    return passwordRegex.test(password);
  };

  /**
   * Method to test if the password and confirm password matches.
   * Simple string comparision is done here.
   * @param password Entered password
   * @param confirmPassword Entered confirm password.
   * @returns boolean
   */
  const isPasswordSame = (password: string, confirmPassword: string): boolean =>
    password === confirmPassword;

  return {
    isEmailValid,
    isPasswordValid,
    isPasswordSame,
  };
};
