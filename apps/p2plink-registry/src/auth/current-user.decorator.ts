import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
export interface CurrentUserValue {
  sub: string;
  role: string;
}
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUserValue =>
    context.switchToHttp().getRequest().user,
);
