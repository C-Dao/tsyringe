import Dictionary from "./types/dictionary";
import constructor from "./types/constructor";
import InjectionToken, {TokenDescriptor} from "./providers/injection-token";
import {ParamInfo} from "./dependency-container";
import Transform from "./types/transform";

export const INJECTION_TOKEN_METADATA_KEY = "injectionTokens";

/** 获取指定构造器的参数信息 */
export function getParamInfo(target: constructor<any>): ParamInfo[] {
  // 获取依赖被注入方的参数信息 [Ctor1, Ctor2, Ctor3]
  const params: any[] = Reflect.getMetadata("design:paramtypes", target) || [];
  // 获取通过 inject， injectAll， injectWithTransform，injectAllWithTransform 装饰器注入的 token 依赖类构造器
  const injectionTokens: Dictionary<InjectionToken<any>> =
    Reflect.getOwnMetadata(INJECTION_TOKEN_METADATA_KEY, target) || {};
  // 对 params 进行替换，替换注入的 token 为实际的依赖类构造器
  Object.keys(injectionTokens).forEach(key => {
    params[+key] = injectionTokens[key];
  });

  return params;
}

/** 参数装饰器工厂，初始化注入依赖参数的描述器 */
export function defineInjectionTokenMetadata(
  //  InjectionToken<any>,要注入依赖的参数 token
  data: any,
  transform?: {
    transformToken: InjectionToken<Transform<any, any>>;
    args: any[];
  }
): (target: any, propertyKey: string | symbol, parameterIndex: number) => any {
  // 返回参数装饰器
  return function(
    target: any,
    _propertyKey: string | symbol,
    parameterIndex: number
  ): any {
    // 获取被注入构造器的参数描述器 map
    const descriptors: Dictionary<InjectionToken<any> | TokenDescriptor> =
      Reflect.getOwnMetadata(INJECTION_TOKEN_METADATA_KEY, target) || {};
    // 如果是 injectTransform 和 injectAllTransform，则生成 transformDescriptor 并设置到 descriptors 中
    descriptors[parameterIndex] = transform
      ? {
          token: data,
          transform: transform.transformToken,
          transformArgs: transform.args || []
        }
      : // 否则直接设置到 descriptors 中
        data;

    // 回写覆盖原来的描述器 map
    Reflect.defineMetadata(INJECTION_TOKEN_METADATA_KEY, descriptors, target);
  };
}
