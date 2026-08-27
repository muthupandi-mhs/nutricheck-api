import {
  ChangePasswordRequest,
  CheckEmailRequest,
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
} from '@nutricheck/contracts';
import { createZodDto } from '../../common/zod/zod-dto';

/**
 * Thin Nest-facing wrappers. The schemas themselves live in
 * @nutricheck/contracts so the mobile client infers its types from the same
 * definition the server validates against.
 */
export class CheckEmailDto extends createZodDto(CheckEmailRequest) {}
export class RegisterDto extends createZodDto(RegisterRequest) {}
export class LoginDto extends createZodDto(LoginRequest) {}
export class RefreshDto extends createZodDto(RefreshRequest) {}
export class ChangePasswordDto extends createZodDto(ChangePasswordRequest) {}
