import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SessionUser } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotFoundProblem } from '../../common/problems';
import { AuthService } from '../auth/auth.service';

@ApiTags('me')
@Controller({ path: 'me', version: '1' })
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @ApiOperation({ summary: 'The signed-in user' })
  async me(@CurrentUser('sub') userId: string): Promise<SessionUser> {
    const user = await this.auth.findSessionUser(userId);
    // Reachable with a still-valid access token after the account was deleted.
    if (!user) throw new NotFoundProblem('User');
    return user;
  }
}
