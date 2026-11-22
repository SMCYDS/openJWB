"""
交大体育系统 (pe.sjtu.edu.cn) 跑步打卡点与规则获取脚本
=====================================================
功能说明：
1. 通过 jAccount 全局单点登录凭证 (JAAuthCookie) 自动执行 OAuth 2.0 授权重定向，获取体育系统的已登录会话 (JSESSIONID)。
2. 调用体育系统隐式接口 /sports/my/uid 生成并获取当前 Session 绑定的动态 Authorization Token。
3. 伪装“交我办”原生跑步模块客户端，携带动态 Token 与坐标参数获取校园长跑打卡点位（必经点/非必经点）及配速规则。

核心机制与防坑提示：
1. 【User-Agent 约束】：
   在调用 jAccount OAuth2 授权端点时，必须使用标准浏览器 User-Agent，
   若使用移动端专用 UA 可能导致 jAccount 阻断自动流转并停留在登录页。
2. 【动态 Authorization 机制】：
   /api/running/point-rule 请求头中的 Authorization 不是静态固定值，
   而是必须由当前 JSESSIONID 会话预先请求 /sports/my/uid 动态生成。
   如果直接使用过期的 Authorization 或跨会话使用，服务端将拦截并报错：
   "code": 1003, "msg": "暂未识别到您的身份信息，请尝试重新进入跑步页面 ~>_<~"
3. 【打卡点与规则数据结构】：
   - points: 打卡点列表，location 为经纬度，isneed 为 'Y'(必经点) 或 'N'(选经点)。
   - rules:  跑步合规判定指标，如 dtlimit(日上限公里数)、simin(单次起跑公里数)、
             rtmin/rtmax(实时配速上下限/秒)、spmin/spmax(平均配速上下限/秒)、
             lduration(最低时长/秒)、tquantum(允许打卡时间窗口)。
"""

import sys
import os
import json
import requests

# 确保控制台支持 UTF-8 编码输出（避免 Windows 终端中文乱码）
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Read login credentials at runtime; never store them in source.
DEFAULT_AUTH_COOKIE = os.environ.get("OPENJWB_AUTH_COOKIE", "")

# 默认定位坐标（上海交大闵行校区经纬度）
DEFAULT_LOCATION = "121.42800347222222,31.024470757378474"


def get_running_point_rule(auth_cookie_val: str, location: str = DEFAULT_LOCATION):
    """
    通过 JAAuthCookie 获取跑步打卡点与规则
    :param auth_cookie_val: jAccount 的 JAAuthCookie 字符串
    :param location: 当前用户的经纬度坐标（格式："经度,纬度"）
    """
    # 建立持久化 HTTP 会话（自动处理并保存 Cookie）
    session = requests.Session()

    # -------------------------------------------------------------
    # 步骤 1：通过 OAuth 2.0 静默授权流建立 pe.sjtu.edu.cn 的合法会话
    # -------------------------------------------------------------
    # 注意：此处必须使用标准桌面端或通用移动浏览器 User-Agent，避免触发登录风控阻断
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
    })

    print("[*] 1. 正在通过 jAccount 完成 OAuth2 登录以获取 PE 会话...")
    # 注入单点登录票据 JAAuthCookie 到 .sjtu.edu.cn 域
    session.cookies.set("JAAuthCookie", auth_cookie_val, domain=".sjtu.edu.cn", path="/")

    # client_id=9mqzULSXYgUYj5fPOpyL 为交大体育系统在 jAccount 平台注册的第一方受信 Client
    auth_url = (
        "https://jaccount.sjtu.edu.cn/oauth2/authorize"
        "?response_type=code&scope=profile&client_id=9mqzULSXYgUYj5fPOpyL&state=8"
        "&redirect_uri=https://pe.sjtu.edu.cn/oauth2Login"
    )
    # allow_redirects=True 会自动流转:
    # 1) jaccount.sjtu.edu.cn/oauth2/authorize
    # 2) jaccount.sjtu.edu.cn/jaccount/jalogin (识别 JAAuthCookie 成功)
    # 3) 授权端点下发 code
    # 4) pe.sjtu.edu.cn/oauth2Login?code=... (后端完成身份校验，签发 JSESSIONID)
    # 5) pe.sjtu.edu.cn/phone/
    session.get(auth_url, allow_redirects=True)

    # 从 session 中提取体育系统专属的 JSESSIONID
    pe_jsessionid = None
    for cookie in session.cookies:
        if cookie.name == "JSESSIONID" and "pe.sjtu.edu.cn" in cookie.domain:
            pe_jsessionid = cookie.value
            break

    if not pe_jsessionid:
        print("[-] 登录失败，未能获取 PE 的 JSESSIONID，可能是 JAAuthCookie 已过期。")
        return

    print(f"[+] 登录成功！当前 PE JSESSIONID: {pe_jsessionid}")

    # -------------------------------------------------------------
    # 步骤 2：获取当前会话绑定的动态 Authorization Token (UID)
    # -------------------------------------------------------------
    # 核心原理：在调用点位规则前，必须先调用 /sports/my/uid 接口。
    # 服务端会在其 Session 缓存中为当前用户生成一个专属的 32 位动态 Token。
    print("[*] 2. 正在调用 /sports/my/uid 注册并生成动态 Authorization Token...")
    uid_resp = session.get("https://pe.sjtu.edu.cn/sports/my/uid").json()
    dynamic_auth = uid_resp.get("data", {}).get("uid")

    if not dynamic_auth:
        print("[-] 获取动态 Authorization 失败，返回数据:", uid_resp)
        return

    print(f"[+] 成功生成动态 Authorization: {dynamic_auth}")

    # -------------------------------------------------------------
    # 步骤 3：请求 /api/running/point-rule 获取打卡点位与跑步规则
    # -------------------------------------------------------------
    print(f"[*] 3. 请求 /api/running/point-rule (坐标: {location})...")
    url = "https://pe.sjtu.edu.cn/api/running/point-rule"
    params = {"location": location}

    # 必须携带与原生 App 一致的请求头，并将步骤 2 拿到的 dynamic_auth 放入 Authorization 头
    headers = {
        "User-Agent": "TaskCenterApp/3.6.4/iPhone 17/ScreenFringe (iOS,iPhone,26.5.2; Scale/3.0)",
        "Cache-Control": "no-cache",
        "Accept-Language": "zh",
        "Authorization": dynamic_auth
    }

    response = session.get(url, params=params, headers=headers)
    print(f"\n[+] 响应状态码: {response.status_code}")
    print("[+] 响应结果:")
    try:
        print(json.dumps(response.json(), ensure_ascii=False, indent=2))
    except Exception:
        print(response.text)


if __name__ == "__main__":
    # 支持从命令行参数直接传入自定义 JAAuthCookie
    cookie_arg = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_AUTH_COOKIE
    get_running_point_rule(cookie_arg)
